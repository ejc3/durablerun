export function requireHostedReceiptBaseUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:') {
    throw new TypeError('DURABLERUN_BASE_URL must use HTTPS')
  }
  return url
}
