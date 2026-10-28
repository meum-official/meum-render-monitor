(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const labels = { pass: '정상', fail: '문제 발견', unknown: '미확인', pending: '점검 대기' };
  const dateFormat = new Intl.DateTimeFormat('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  let state = null;
  let connected = false;
  let filter = 'all';
  let fetching = false;
  let requestingRun = false;
  let lastFetchAt = 0;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function formatDate(value) {
    const date = new Date(value);
    return value && Number.isFinite(date.getTime()) ? dateFormat.format(date) : '아직 점검하지 않음';
  }
  function isStale(result) {
    const checked = new Date(result.checkedAt || state?.completedAt).getTime();
    const ttl = Math.max(2 * (Number(state?.intervalMinutes) || 0), 60) * 60_000;
    return !connected || !Number.isFinite(checked) || Date.now() - checked > ttl;
  }
  function statusOf(result) {
    return ['pass', 'fail'].includes(result.status) && !isStale(result) ? result.status : 'unknown';
  }
  function safeLink(value, screenshot = false) {
    try {
      const url = new URL(screenshot && String(value).startsWith('/screenshots/') ? String(value).slice(1) : value, document.baseURI);
      if (!['https:', 'http:'].includes(url.protocol)) return null;
      if (screenshot && (url.origin !== window.location.origin || !url.pathname.startsWith(new URL('screenshots/', document.baseURI).pathname))) return null;
      return url.href;
    } catch { return null; }
  }
  function makeLink(value, label, className, screenshot = false) {
    const url = safeLink(value, screenshot);
    const node = el(url ? 'a' : 'span', className, label);
    if (url) { node.href = url; node.target = '_blank'; node.rel = 'noopener noreferrer'; }
    return node;
  }
  function issueMessage(issue) {
    return typeof issue === 'string' ? issue : String(issue?.message || issue?.kind || '알 수 없는 오류');
  }
  function renderOverview(results) {
    const counts = { pass: 0, fail: 0, unknown: 0 };
    for (const row of results) counts[statusOf(row)] += 1;
    const total = Math.max(results.length, Number(state.discovery?.totalTargets) || 0);
    counts.unknown += total - results.length;
    $('total-count').textContent = total.toLocaleString('ko-KR');
    for (const key of ['pass', 'fail', 'unknown']) $(key + '-count').textContent = counts[key].toLocaleString('ko-KR');
    const running = state.status === 'running';
    const complete = state.discovery?.complete === true;
    let kind = 'unknown';
    let title = '아직 확인되지 않은 페이지가 있습니다';
    let description = '대기 중이거나 오래된 결과는 정상으로 표시하지 않습니다.';
    if (!connected) { title = '점검 서버에 연결할 수 없습니다'; description = '표시된 이전 결과의 현재 상태를 확인할 수 없습니다.'; }
    else if (counts.fail) { kind = 'fail'; title = `${counts.fail.toLocaleString('ko-KR')}개 페이지에서 문제가 발견됐습니다`; description = running ? '나머지 페이지를 계속 점검하고 있습니다. 아래에서 오류와 화면을 확인하세요.' : '아래 빨간 표시의 페이지를 펼쳐 오류와 당시 화면을 확인하세요.'; }
    else if (running) { kind = 'running'; title = '공개 페이지를 점검하고 있습니다'; description = '페이지를 실제 브라우저에서 순서대로 열고 렌더링 결과를 확인합니다.'; }
    else if (state.status === 'failed') { title = '전체 점검을 완료하지 못했습니다'; description = '수집 및 실행 오류를 확인하세요. 미확인 페이지는 정상으로 표시하지 않습니다.'; }
    else if (total > 0 && !counts.unknown && complete) { kind = 'pass'; title = '점검한 모든 페이지가 정상입니다'; description = `${total.toLocaleString('ko-KR')}개 페이지가 설정된 브라우저 검사 기준을 통과했습니다.`; }
    else if (!complete && state.startedAt) { title = '공개 페이지 목록 수집을 확인해 주세요'; description = '목록이 완전하지 않아 서비스 전체가 정상이라고 판단할 수 없습니다.'; }
    else if (!total) { title = '첫 점검을 기다리고 있습니다'; description = '실제 검사 결과가 들어오면 페이지별 상태를 표시합니다.'; }
    $('overview-title').textContent = title;
    $('overview-description').textContent = description;
    $('overview-beacon').className = 'beacon ' + kind;
    $('completed-at').textContent = formatDate(state.completedAt);
    $('next-run').textContent = running ? '현재 점검 중' : state.nextRunAt ? formatDate(state.nextRunAt) : state.scheduleDescription || (state.mode === 'after-deploy' ? '배포 변경 감시 중' : '수동 실행');
    $('run-button').disabled = running || requestingRun || !connected || (state.readOnly && !safeLink(state.workflowUrl));
    $('run-button').replaceChildren(el('span', '', '↻'), document.createTextNode(state.readOnly ? ' GitHub에서 점검 실행 ↗' : running ? ' 전체 점검 중' : ' 지금 전체 점검'));
    document.querySelector('.refresh-label').replaceChildren(el('span', 'dot dot-blue'), document.createTextNode(state.readOnly ? ' 1분마다 갱신' : ' 5초마다 갱신'));
    if (state.watcherError) $('action-message').textContent = '배포 변경 감시 오류: ' + state.watcherError;
    const checked = results.filter((row) => row.checkedAt && row.status !== 'pending').length;
    const percent = total ? Math.min(100, Math.round(checked / total * 100)) : 0;
    $('progress-bar').style.width = percent + '%';
    $('progress-label').textContent = `${checked.toLocaleString('ko-KR')} / ${total.toLocaleString('ko-KR')} 페이지 확인${running ? ' · 점검 중' : ''}`;
    $('progress-percent').textContent = percent + '%';
    const badge = $('coverage-badge');
    badge.textContent = !connected ? '연결 확인 필요' : complete ? '목록 수집 완료' : running ? '목록 수집 중 / 확인 필요' : '목록 완전성 미확인';
    badge.className = 'badge ' + (!connected ? 'unknown' : complete ? 'pass' : running ? 'running' : 'unknown');
    const exhibitions = Number(state.discovery?.totalExhibitions);
    $('coverage-description').textContent = `공개 전시 ${Number.isFinite(exhibitions) ? exhibitions.toLocaleString('ko-KR') : '미확인'}개 · 점검 대상 ${total.toLocaleString('ko-KR')}페이지. ${complete ? '공개 목록 수집을 완료했습니다.' : '전체 공개 목록이 수집됐는지 아직 확인되지 않았습니다.'}`;
    $('coverage-source').textContent = state.discovery?.source ? '수집 경로: ' + String(state.discovery.source) : '';
    const errors = Array.isArray(state.discovery?.errors) ? state.discovery.errors : [];
    $('discovery-errors').hidden = !errors.length;
    $('discovery-errors').replaceChildren(...errors.map((error) => el('li', '', issueMessage(error))));
  }
  function rowDetail(result) {
    const detail = el('div', 'page-detail');
    const evidence = el('div');
    evidence.append(el('p', 'detail-label', '검사 근거'));
    evidence.append(el('p', 'detail-meta', `그룹: ${result.group || '기타'} · 확인: ${formatDate(result.checkedAt)} · 응답: ${result.httpStatus ?? '미확인'} · 소요: ${Number.isFinite(result.durationMs) ? (result.durationMs / 1000).toFixed(1) + '초' : '미확인'}`));
    const issues = Array.isArray(result.issues) ? result.issues.map(issueMessage) : [];
    if (['pass', 'fail'].includes(result.status) && isStale(result)) issues.unshift(connected ? '이 결과는 오래되어 현재 상태를 미확인으로 표시합니다. 새 점검이 필요합니다.' : '점검 서버와 연결이 끊겨 현재 상태를 확인할 수 없습니다.');
    if (result.status === 'pending') issues.unshift('아직 이 페이지를 점검하지 않았습니다.');
    if (issues.length) {
      const list = el('ul', 'issue-list');
      list.append(...issues.map((issue) => el('li', '', issue)));
      evidence.append(list);
    }
    if (Array.isArray(result.checks) && result.checks.length) {
      const list = el('ul', 'check-list');
      for (const check of result.checks) {
        const item = el('li');
        item.append(el('span', 'dot ' + (check.passed === true ? 'dot-green' : check.passed === false ? 'dot-red' : 'dot-gray')), el('span', '', String(check.name || '검사')));
        if (check.detail) item.append(el('span', 'check-detail', String(check.detail)));
        list.append(item);
      }
      evidence.append(list);
    } else if (!issues.length) evidence.append(el('p', 'muted', '상세 검사 근거가 아직 없습니다.'));
    evidence.append(makeLink(result.url, '실제 페이지 열기 ↗', 'detail-link'));
    const capture = el('div');
    capture.append(el('p', 'detail-label', '점검 당시 화면'));
    if (result.screenshot && safeLink(result.screenshot, true)) {
      const link = makeLink(result.screenshot, undefined, 'screenshot-link', true);
      const img = el('img');
      img.src = safeLink(result.screenshot, true);
      img.alt = `${result.name || result.id || '페이지'} 점검 당시 화면`;
      img.loading = 'lazy';
      img.addEventListener('error', () => { link.replaceChildren(el('span', 'no-screenshot', '캡처 파일을 불러올 수 없습니다')); }, { once: true });
      link.append(img, el('span', 'screenshot-caption', '화면 크게 보기 ↗'));
      capture.append(link);
    } else capture.append(el('div', 'no-screenshot', '저장된 화면이 없습니다'));
    detail.append(evidence, capture);
    return detail;
  }
  function renderResults() {
    const results = Array.isArray(state?.results) ? state.results : [];
    const groups = [...new Set(results.map((result) => result.group).filter(Boolean))].sort();
    const selectedGroup = $('group-filter').value;
    const firstOption = el('option', '', '모든 그룹'); firstOption.value = '';
    $('group-filter').replaceChildren(firstOption, ...groups.map((group) => { const option = el('option', '', String(group)); option.value = String(group); return option; }));
    $('group-filter').value = groups.includes(selectedGroup) ? selectedGroup : '';
    const query = $('search').value.trim().toLocaleLowerCase();
    const shown = results.filter((result) => (filter === 'all' || statusOf(result) === filter) && (!$('group-filter').value || result.group === $('group-filter').value) && (!query || [result.name, result.url, result.group, result.id].some((value) => String(value || '').toLocaleLowerCase().includes(query))));
    const priorities = { fail: 0, unknown: 1, pass: 2 };
    shown.sort((a, b) => priorities[statusOf(a)] - priorities[statusOf(b)] || String(a.name || a.id).localeCompare(String(b.name || b.id), 'ko'));
    $('visible-count').textContent = `${shown.length.toLocaleString('ko-KR')} / ${results.length.toLocaleString('ko-KR')}`;
    const openRows = new Set([...$('results').querySelectorAll('details[open]')].map((node) => node.dataset.id));
    const fragment = document.createDocumentFragment();
    if (!shown.length) {
      const empty = el('div', 'empty-state');
      empty.append(el('span', 'empty-symbol', '◎'), el('h3', '', results.length ? '조건에 맞는 페이지가 없습니다' : '아직 점검 결과가 없습니다'), el('p', '', results.length ? '다른 상태 또는 검색어로 확인해 주세요.' : '첫 점검이 시작되면 공개 페이지가 여기에 표시됩니다.'));
      fragment.append(empty);
    } else {
      const head = el('div', 'results-header');
      head.setAttribute('aria-hidden', 'true');
      head.append(el('span', '', '점검 상태'), el('span', '', '페이지'), el('span', 'group-column', '구분'), el('span', 'time-column', '최근 확인'), el('span'));
      fragment.append(head);
      for (const result of shown) {
        const status = statusOf(result);
        const row = el('details', 'page-row'); row.dataset.id = String(result.id || result.url); row.open = openRows.has(row.dataset.id);
        const summary = el('summary', 'page-summary');
        const badge = el('span', 'status-label ' + status);
        badge.append(el('span', 'dot dot-' + (status === 'pass' ? 'green' : status === 'fail' ? 'red' : 'gray')), document.createTextNode(status === 'unknown' && result.status === 'pending' ? labels.pending : labels[status]));
        const identity = el('span'); identity.append(el('span', 'page-name', String(result.name || result.id || '페이지')), el('span', 'page-path', String(result.url || '주소 없음')));
        summary.append(badge, identity, el('span', 'group-text', String(result.group || '기타')), el('span', 'time-text', formatDate(result.checkedAt)), el('span', 'chevron', '›'));
        row.append(summary, rowDetail(result));
        fragment.append(row);
      }
    }
    $('results').replaceChildren(fragment);
  }
  function renderHistory() {
    const history = Array.isArray(state.history) ? state.history.slice(-10).reverse() : [];
    if (!history.length) { $('history').replaceChildren(el('p', 'muted', '완료된 점검 이력이 아직 없습니다.')); return; }
    const grid = el('div', 'history-grid');
    for (const run of history) {
      const item = el('article', 'history-item');
      const time = el('time', '', formatDate(run.completedAt));
      if (run.completedAt) time.dateTime = run.completedAt;
      item.append(time);
      const bar = el('div', 'history-bar'); bar.setAttribute('aria-hidden', 'true');
      const total = Number(run.total) || 1;
      const legend = el('p');
      for (const [status, color] of [['pass', 'green'], ['fail', 'red'], ['unknown', 'gray']]) {
        const count = Math.max(0, Number(run[status]) || 0);
        const segment = el('span', 'dot-' + color); segment.style.width = Math.min(100, count / total * 100) + '%'; bar.append(segment);
        const label = el('span'); label.append(el('span', 'dot dot-' + color), document.createTextNode(`${labels[status]} ${count}`)); legend.append(label);
      }
      item.append(bar, legend); grid.append(item);
    }
    $('history').replaceChildren(grid);
  }
  function render() {
    if (!state) return;
    renderOverview(Array.isArray(state.results) ? state.results : []);
    renderResults();
    renderHistory();
  }
  async function refresh() {
    if (fetching) return;
    fetching = true;
    lastFetchAt = Date.now();
    try {
      const response = await fetch(new URL(document.querySelector('meta[name="monitor-report"]')?.content || 'api/status', document.baseURI), { cache: 'no-cache', signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = await response.json();
      if (!next || !Array.isArray(next.results)) throw new Error('올바른 점검 결과를 받지 못했습니다');
      state = next; connected = true;
      $('connection-error').hidden = true;
    } catch (error) {
      connected = false;
      $('connection-error').textContent = `점검 서버에 연결할 수 없습니다. 이전 결과는 미확인으로 표시합니다. (${error.message})`;
      $('connection-error').hidden = false;
      $('run-button').disabled = true;
      if (!state) { $('overview-title').textContent = '점검 서버에 연결할 수 없습니다'; $('overview-description').textContent = '연결이 복구되면 자동으로 다시 확인합니다.'; }
    } finally { fetching = false; render(); }
  }
  $('run-button').addEventListener('click', async () => {
    if (state?.readOnly) { const url = safeLink(state.workflowUrl); if (url) window.open(url, '_blank', 'noopener,noreferrer'); return; }
    requestingRun = true; $('run-button').disabled = true; $('action-message').textContent = '전체 점검을 요청하고 있습니다…';
    try {
      const response = await fetch(new URL('api/run', document.baseURI), { method: 'POST', signal: AbortSignal.timeout(15_000) });
      if (response.status === 409) $('action-message').textContent = '이미 전체 점검이 진행 중입니다.';
      else if (!response.ok) throw new Error(`HTTP ${response.status}`);
      else $('action-message').textContent = '전체 점검을 시작했습니다. 결과는 페이지별로 갱신됩니다.';
    } catch (error) { $('action-message').textContent = `점검을 시작할 수 없습니다. ${error.message}`; }
    finally { requestingRun = false; await refresh(); }
  });
  for (const tab of document.querySelectorAll('[data-filter]')) tab.addEventListener('click', () => {
    filter = tab.dataset.filter;
    for (const button of document.querySelectorAll('[data-filter]')) { const active = button === tab; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }
    renderResults();
  });
  $('group-filter').addEventListener('change', renderResults);
  $('search').addEventListener('input', renderResults);
  refresh();
  setInterval(() => { if (!state?.readOnly || Date.now() - lastFetchAt >= 60_000) refresh(); }, 5_000);
})();
