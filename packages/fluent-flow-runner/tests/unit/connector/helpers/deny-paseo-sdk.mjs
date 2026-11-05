import { register } from 'node:module';

const transitive = new URL(import.meta.url).searchParams.get('transitive') === '1';
const hook = `
const transitive = ${JSON.stringify(transitive)};
function missing(name, parentURL) {
  const error = new Error("Cannot find package '" + name + "' imported from " + (parentURL ?? 'unknown'));
  error.code = 'ERR_MODULE_NOT_FOUND';
  return error;
}
export async function resolve(specifier, context, next) {
  const fromSdk = (context.parentURL ?? '').includes('/@getpaseo/client/');
  if (!transitive && (specifier === '@getpaseo/client' || specifier.startsWith('@getpaseo/client/'))) throw missing('@getpaseo/client', context.parentURL);
  if (transitive && fromSdk && specifier.startsWith('@getpaseo/protocol')) throw missing('@getpaseo/protocol', context.parentURL);
  return next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);
