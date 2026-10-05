import { tExpr as _tExpr, useFlowEngine } from '@nocobase/flow-engine';
// @ts-ignore package metadata is injected by the plugin build.
import pkg from './../../package.json';

export function useT() {
  const engine = useFlowEngine();
  return (key: string) => engine.context.t(key, { ns: [pkg.name, 'client'] });
}

export function tExpr(key: string) {
  return _tExpr(key, { ns: [pkg.name, 'client'] });
}
