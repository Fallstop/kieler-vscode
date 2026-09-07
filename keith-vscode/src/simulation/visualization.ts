import { get } from 'http'
import { delay } from './helper'

/** The server notification has no reply; wait until its HTTP endpoint is accepting requests. */
export async function waitForVisualization(url: string, timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        const ready = await new Promise<boolean>((resolve) => {
            const request = get(url, (response) => {
                response.resume()
                resolve(response.statusCode !== undefined && response.statusCode < 400)
            })
            request.setTimeout(500, () => request.destroy())
            request.on('error', () => resolve(false))
        })
        if (ready) return
        // eslint-disable-next-line no-await-in-loop
        await delay(100)
    }
    throw new Error('The visualization server did not become ready. Check the KIELER language server output.')
}
