export function shortenAddress(addr: string, left = 6, right = 4) {
  if (addr.length <= left + right + 3) return addr;
  return `${addr.slice(0, left)}…${addr.slice(-right)}`;
}
