import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

async function treeBytes(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) bytes += await treeBytes(filename);
    else if (entry.isFile()) bytes += (await stat(filename)).size;
    else throw new Error('게시 폴더에는 일반 파일과 폴더만 허용합니다.');
  }
  return bytes;
}

export async function exportReport({ dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data')), siteDir = path.join(root, 'site'), workflowUrl = process.env.MONITOR_WORKFLOW_URL || '', scanStartedAt = process.env.MONITOR_SCAN_STARTED_AT, maxSiteBytes = 100 * 1024 * 1024, normalScreenshotLimit = 3 } = {}) {
  siteDir = path.resolve(siteDir);
  dataDir = path.resolve(dataDir);
  if (siteDir === path.resolve(root) || path.resolve(root).startsWith(siteDir + path.sep) || siteDir === dataDir || dataDir.startsWith(siteDir + path.sep)) throw new Error('게시 폴더는 원본 코드 및 점검 데이터와 분리해야 합니다.');
  if (!Number.isSafeInteger(maxSiteBytes) || maxSiteBytes < 1 || !Number.isSafeInteger(normalScreenshotLimit) || normalScreenshotLimit < 0) throw new Error('게시 용량 및 정상 캡처 수 설정이 올바르지 않습니다.');
  let report;
  try { report = JSON.parse(await readFile(path.join(dataDir, 'status.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    report = { schemaVersion: 1, status: 'failed', results: [], history: [], discovery: { complete: false, errors: ['점검 결과 파일이 없습니다. GitHub 실행 로그를 확인해 주세요.'] } };
  }
  if (!report || !Array.isArray(report.results)) throw new Error('점검 결과 JSON 형식이 올바르지 않습니다.');
  let ci = null;
  try { ci = JSON.parse(await readFile(path.join(dataDir, 'ci-state.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const attemptTime = Date.parse(report.attemptStartedAt || report.startedAt);
  const newScanMissing = scanStartedAt && (!Number.isFinite(attemptTime) || attemptTime < Date.parse(scanStartedAt) - 5000);
  if (newScanMissing) {
    report.status = 'failed';
    report.results = report.results.map(result => ({ ...result, status: 'unknown', issues: [...(result.issues || []), { kind: 'monitor', message: '이번 GitHub 실행에서 새 점검을 시작하지 못했습니다. 이전 화면은 참고용입니다.' }] }));
    report.discovery = { ...report.discovery, complete: false, errors: [...(report.discovery?.errors || []), '이번 실행에서 새 브라우저 점검 결과가 생성되지 않았습니다.'] };
  }
  if (report.status === 'running') {
    report.status = 'failed';
    report.discovery = { ...report.discovery, complete: false, errors: [...(report.discovery?.errors || []), '점검이 도중에 종료되어 일부 페이지만 확인됐습니다.'] };
  }
  report.readOnly = true;
  report.workflowUrl = workflowUrl;
  report.exportedAt = new Date().toISOString();
  report.nextRunAt = null;
  report.monitorMode = ci?.mode || 'after-deploy';
  report.watchUntil = ci?.watchUntil || null;
  report.scheduleDescription = ci?.mode === 'continuous' ? 'GitHub Actions에서 매시간 브라우저 점검을 실행합니다. 예약 실행은 지연될 수 있습니다.' : 'GitHub Actions에서 매시간 확인하며, 배포 후 6시간 동안 브라우저를 실행합니다. 예약 실행은 지연될 수 있습니다.';
  await mkdir(siteDir, { recursive: true });
  await cp(path.join(root, 'public'), siteDir, { recursive: true });
  const indexFile = path.join(siteDir, 'index.html');
  const index = await readFile(indexFile, 'utf8');
  if (!index.includes('</head>')) throw new Error('대시보드 HTML에 head 닫는 태그가 없습니다.');
  await writeFile(indexFile, index.replace('</head>', '  <meta name="monitor-report" content="./status.json" />\n  </head>'));
  await writeFile(path.join(siteDir, '.nojekyll'), '');
  const outputScreenshots = path.resolve(siteDir, 'screenshots');
  if (path.dirname(outputScreenshots) !== siteDir) throw new Error('게시 캡처 폴더 경로가 올바르지 않습니다.');
  await rm(outputScreenshots, { recursive: true, force: true });
  const screenshotRoot = path.join(dataDir, 'screenshots');
  const references = new Map();
  for (const row of report.results) if (row.screenshot) {
    if (!references.has(row.screenshot)) references.set(row.screenshot, []);
    references.get(row.screenshot).push(row);
  }
  const priority = rows => rows.some(row => row.status === 'fail') ? 0 : rows.some(row => row.status !== 'pass') ? 1 : 2;
  const ordered = [...references].sort((a, b) => priority(a[1]) - priority(b[1]));
  let remaining = maxSiteBytes - await treeBytes(siteDir) - Buffer.byteLength(JSON.stringify(report, null, 2)) - references.size * 1024 - 4096;
  let copied = 0;
  let omitted = 0;
  let normalCopied = 0;
  const omit = (rows, message) => {
    omitted++;
    for (const row of rows) {
      row.screenshot = null;
      row.screenshotOmittedReason = message;
      row.issues = [...(row.issues || []), { kind: 'evidence', message }];
    }
  };
  for (const [screenshot, rows] of ordered) {
    if (typeof screenshot !== 'string' || !screenshot.startsWith('/screenshots/')) throw new Error('화면 캡처 경로가 올바르지 않습니다.');
    const relative = screenshot.slice('/screenshots/'.length);
    const source = path.resolve(screenshotRoot, relative);
    if (!source.startsWith(path.resolve(screenshotRoot) + path.sep)) throw new Error('화면 캡처 경로가 저장 폴더를 벗어납니다.');
    const destination = path.resolve(siteDir, 'screenshots', relative);
    if (priority(rows) === 2 && normalCopied >= normalScreenshotLimit) {
      omit(rows, `무료 대시보드 용량을 줄이기 위해 정상 페이지 캡처는 대표 ${normalScreenshotLimit}개만 게시합니다. 검사 판정은 그대로 유지됩니다.`);
      continue;
    }
    try {
      const sourceStat = await stat(source);
      if (!sourceStat.isFile()) throw new Error('화면 캡처가 일반 파일이 아닙니다.');
      if (sourceStat.size > remaining) {
        omit(rows, '무료 대시보드의 100MB 용량 제한으로 캡처 게시를 생략했습니다. 문제 페이지를 우선하며 검사 판정은 그대로 유지됩니다.');
        continue;
      }
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(source, destination);
      remaining -= sourceStat.size;
      copied++;
      if (priority(rows) === 2) normalCopied++;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      omit(rows, '화면 캡처 파일이 없어 내보내지 못했습니다.');
    }
  }
  report.evidence = { copiedScreenshots: copied, omittedScreenshots: omitted, normalScreenshotLimit, maxSiteBytes };
  await writeFile(path.join(siteDir, 'status.json.tmp'), JSON.stringify(report, null, 2) + '\n');
  await rename(path.join(siteDir, 'status.json.tmp'), path.join(siteDir, 'status.json'));
  if (await treeBytes(siteDir) > maxSiteBytes) throw new Error('게시 폴더가 100MB 제한을 초과했습니다. 게시하지 않습니다.');
  console.log(`읽기 전용 대시보드 내보내기 완료: ${report.results.length}페이지 (${report.status})`);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await exportReport().catch(error => { console.error(error.message); process.exitCode = 2; });
