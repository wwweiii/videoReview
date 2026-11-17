import crypto from 'node:crypto'

/** 轨迹保留图片类型、大小及摘要，不重复保存 Base64 图片本体。 */
export function compactRequestBody(body: string): string {
  return body.replace(/data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)/gi, (_match, mime: string, data: string) => {
    const bytes = Buffer.from(data, 'base64')
    const hash = crypto.createHash('sha256').update(bytes).digest('hex')
    return `[image mime=${mime} bytes=${bytes.length} sha256=${hash}]`
  })
}
