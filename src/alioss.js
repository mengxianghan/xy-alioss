import { generateFilename } from './utils/generate'
import { deepMerge, guid } from './utils'
import { formatResponse } from './utils/format'
import Event from './utils/event'
import OSS from 'ali-oss'

export default class AliOSS {
    #opts
    #client = null
    #event
    #retryQueue

    constructor(options) {
        this.#event = new Event()
        this.#retryQueue = new Map()
        this.#opts = deepMerge(
            {
                async: false,
                rootPath: '',
                rename: true,
                enableCdn: false,
                cdnUrl: '',
                retryCount: 5,
                refreshSTSTokenInterval: 300000,
                config: {
                    headers: {
                        'Cache-Control': 'public',
                    },
                },
                refreshSTSToken: () => {},
                getOptions: () => {},
            },
            options
        )
    }

    /**
     * 获取储存
     * @returns {Promise}
     */
    getStore() {
        return new Promise((resolve) => {
            ;(async () => {
                if (this.#client) {
                    resolve(this.#client)
                    return
                }

                if (this.#event.length - 1) return

                if (this.#opts.async) {
                    const options = await this.#opts.getOptions().catch(() => {})
                    this.#opts = {
                        ...this.#opts,
                        ...(options || {}),
                    }
                }

                const { async, getOptions, ...options } = this.#opts

                this.#client = new OSS({
                    ...options,
                })

                resolve(this.#client)
            })()
        })
    }

    /**
     * 上传
     * @param {string} filename
     * @param {File | Blob | Buffer} data
     * @param {object} config
     * @returns {Promise}
     */
    put(filename, data, config = {}) {
        return new Promise((resolve, reject) => {
            this.#event.on(guid(), async () => {
                try {
                    config = deepMerge(this.#opts?.config || {}, config)
                    const rename = config.hasOwnProperty('rename') ? config?.rename : this.#opts.rename
                    const result = await this.#client
                        .put(
                            generateFilename({
                                filename,
                                rename,
                                rootPath: this.#opts?.rootPath,
                            }),
                            data,
                            config
                        )
                        .catch((err) => {
                            throw err
                        })
                    resolve(
                        formatResponse({
                            data: result,
                            enableCdn: this.#opts?.enableCdn,
                            cdnUrl: this.#opts?.cdnUrl,
                        })
                    )
                } catch (error) {
                    reject(error)
                }
            })
            this.#init()
        })
    }

    /**
     * 分片上传
     * @param {string} filename
     * @param {File | Blob | Buffer} data
     * @param {object} config
     * @returns {Promise}
     */
    multipartUpload(filename, data, config = {}) {
        return new Promise((resolve, reject) => {
            this.#event.on(guid(), async () => {
                try {
                    config = deepMerge(this.#opts?.config || {}, config)
                    // 是否重试
                    const isRetry = config?.__isRetry || false
                    const rename = config.hasOwnProperty('rename') ? config?.rename : this.#opts.rename
                    filename =
                        config.checkpoint || isRetry
                            ? filename
                            : generateFilename({
                                  filename,
                                  rename,
                                  rootPath: this.#opts?.rootPath,
                              })
                    // 如果不是重试，删除队列
                    if (!isRetry) {
                        this.#retryQueue.delete(filename)
                    }
                    const result = await this.#client.multipartUpload(filename, data, config).catch((err) => {
                        if (this.#client && this.#client.isCancel()) {
                            throw err
                        } else {
                            if (!this.#retryQueue.has(filename)) {
                                this.#retryQueue.set(filename, 0)
                            }

                            const count = this.#retryQueue.get(filename)

                            if (count < this.#opts.retryCount) {
                                this.#retryQueue.set(filename, count + 1)
                                this.multipartUpload(filename, data, { ...config, __isRetry: true })
                            }
                            throw err
                        }
                    })
                    resolve(
                        formatResponse({
                            data: result,
                            enableCdn: this.#opts.enableCdn,
                            cdnUrl: this.#opts?.cdnUrl,
                        })
                    )
                } catch (error) {
                    reject(error)
                }
            })
            this.#init()
        })
    }

    /**
     * @returns {Promise<void>}
     */
    #init() {
        return new Promise((resolve) => {
            ;(async () => {
                if (this.#client) {
                    this.#event.emit()
                    resolve(this.#client)
                    return
                }

                await this.getStore()

                this.#event.emit()
                resolve(this.#client)
            })()
        })
    }
}
