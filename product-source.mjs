import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUSINESS_SOURCE_FILES } from './business-contracts.mjs';

const monitorRoot = path.dirname(fileURLToPath(import.meta.url));
export function productSourceRoot(optional = false) {
  if (process.env.MEUM_PRODUCT_ROOT && path.isAbsolute(process.env.MEUM_PRODUCT_ROOT)) return path.resolve(process.env.MEUM_PRODUCT_ROOT);
  if (optional) return path.join(monitorRoot, '.unconfigured-product-source');
  throw new Error('Optional product fixtures require an explicit absolute MEUM_PRODUCT_ROOT. Public rendering does not require product source.');
}
export function reviewedSourceFile(relative) {
  if (!Object.values(BUSINESS_SOURCE_FILES).includes(relative)) throw new Error('Unregistered fixture source');
  const prefix = 'tools/meum-render-monitor/';
  return relative.startsWith(prefix) ? path.join(monitorRoot, relative.slice(prefix.length)) : path.join(productSourceRoot(), relative);
}
