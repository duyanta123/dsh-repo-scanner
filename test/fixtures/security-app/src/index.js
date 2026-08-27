export function main() {
  const password = process.env.PASSWORD || 'hardcoded-fallback';
  return password;
}
