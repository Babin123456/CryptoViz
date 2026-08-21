'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CipherResult } from '@/lib/cipher/types'
import type { WorkerRequest, WorkerResponse } from '@/types/worker'
import type { WorkerPriority } from '@/lib/workers/pool'
import type { WorkerProgressMessage } from '@/lib/workers/cipher-worker-protocol'
import { CipherError } from '@/lib/utils/errors'

const MAX_CACHE_SIZE = 200
const WORKER_TIMEOUT_MS = 10000
const resultCache = new Map<string, CipherResult>()

export interface CipherWorkerProgress {
  percent: number
  currentMilestone: string
  jobId: string
}

export interface RunCipherOptions {
  signal?: AbortSignal
  bypassCache?: boolean
  priority?: WorkerPriority
  onProgress?: (percent: number, message: string) => void
  [key: string]: unknown
}

interface RequestHandlers {
  resolve: (value: CipherResult) => void
  reject: (reason: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
  timeoutId: ReturnType<typeof setTimeout>
  cacheKey: string | null
  onProgress?: (percent: number, message: string) => void
}

function sortObjectKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(sortObjectKeys)
  const record = obj as Record<string, unknown>
  return Object.fromEntries(Object.keys(record).sort().map(k => [k, sortObjectKeys(record[k])]))
}

function getCacheKey(
  action: 'encrypt' | 'decrypt',
  cipherId: string,
  input: string,
  key: string,
  options?: RunCipherOptions
): string {
  const { signal: _, bypassCache: __, onProgress: ___, priority: ____, ...cacheableOptions } = options || {}
  return JSON.stringify({ action, cipherId, input, key, options: sortObjectKeys(cacheableOptions) })
}

function cacheResult(key: string, result: CipherResult) {
  if (resultCache.has(key)) resultCache.delete(key)
  else if (resultCache.size >= MAX_CACHE_SIZE) {
    const oldest = resultCache.keys().next().value
    if (oldest !== undefined) resultCache.delete(oldest)
  }
  resultCache.set(key, result)
}

export function clearCipherWorkerCache() {
  resultCache.clear()
}

export function useCipherWorker() {
  const workerRef = useRef<Worker | null>(null)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState<CipherWorkerProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fatalError, setFatalError] = useState<Error | null>(null)
  const activeRequestsRef = useRef<Map<string, RequestHandlers>>(new Map())

  useEffect(() => {
    if (typeof window === 'undefined') return

    const worker = new Worker(
      new URL('../lib/workers/cipher.worker.ts', import.meta.url),
      { type: 'module' },
    )
    workerRef.current = worker

    const handleMessage = (event: MessageEvent<WorkerResponse | WorkerProgressMessage>) => {
      const data = event.data
      if (data.type === 'PROGRESS') {
        setProgress({
          percent: data.percent,
          currentMilestone: data.currentMilestone,
          jobId: data.jobId,
        })
        const handler = activeRequestsRef.current.get(data.jobId)
        handler?.onProgress?.(data.percent, data.currentMilestone)
        return
      }

      const { requestId, success, payload, timings } = data
      const handlers = activeRequestsRef.current.get(requestId)
      if (!handlers) return

      const { resolve, reject, timeoutId, signal, onAbort, cacheKey } = handlers
      clearTimeout(timeoutId)
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
      activeRequestsRef.current.delete(requestId)

      if (activeRequestsRef.current.size === 0) {
        setLoading(false)
        setProgress(null)
      }

      if (success && payload?.result) {
        const result: CipherResult = {
          ...payload.result,
          durationMs: timings?.durationMs ?? payload.result.durationMs ?? 0,
        }
        if (cacheKey) cacheResult(cacheKey, result)
        resolve(result)
      } else {
        const errorMsg = payload?.error ?? 'Operation failed in worker'
        const code = payload?.errorCode
        const cipherErr = code ? new CipherError(code, errorMsg) : new Error(errorMsg)
        setError(errorMsg)
        reject(cipherErr)
      }
    }

    const handleError = (event: ErrorEvent) => {
      const fatal = new Error(`Worker initialization error: ${event.message}`)
      setFatalError(fatal)
      setLoading(false)
      setProgress(null)
      for (const [, handlers] of activeRequestsRef.current) {
        clearTimeout(handlers.timeoutId)
        handlers.reject(fatal)
      }
      activeRequestsRef.current.clear()
    }

    worker.addEventListener('message', handleMessage)
    worker.addEventListener('error', handleError)

    return () => {
      worker.removeEventListener('message', handleMessage)
      worker.removeEventListener('error', handleError)
      worker.terminate()
      workerRef.current = null
      for (const [, handlers] of activeRequestsRef.current) {
        clearTimeout(handlers.timeoutId)
        handlers.reject(new DOMException('The worker was terminated.', 'AbortError'))
      }
      activeRequestsRef.current.clear()
    }
  }, [])

  const runCipher = useCallback(
    async (
      action: 'encrypt' | 'decrypt',
      cipherId: string,
      input: string,
      key: string,
      options?: RunCipherOptions,
    ): Promise<CipherResult> => {
      const cacheKey = options?.bypassCache ? null : getCacheKey(action, cipherId, input, key, options)
      if (cacheKey && resultCache.has(cacheKey)) {
        return resultCache.get(cacheKey)!
      }

      if (fatalError) throw fatalError
      if (!workerRef.current) throw new Error('Worker is not available in SSR context.')

      return new Promise<CipherResult>((resolve, reject) => {
        const id = crypto.randomUUID()
        const signal = options?.signal

        const onAbort = () => {
          if (workerRef.current) {
            workerRef.current.postMessage({ type: 'CANCEL', jobId: id })
          }
          const handlers = activeRequestsRef.current.get(id)
          if (handlers) {
            clearTimeout(handlers.timeoutId)
            activeRequestsRef.current.delete(id)
          }
          if (activeRequestsRef.current.size === 0) {
            setLoading(false)
            setProgress(null)
          }
          reject(new DOMException('The user aborted the request.', 'AbortError'))
        }

        if (signal?.aborted) {
          onAbort()
          return
        }

        if (signal) {
          signal.addEventListener('abort', onAbort, { once: true })
        }

        const timeoutId = setTimeout(() => {
          activeRequestsRef.current.delete(id)
          if (activeRequestsRef.current.size === 0) {
            setLoading(false)
            setProgress(null)
          }
          reject(new CipherError('WORKER_TIMEOUT', `Cipher operation timed out after ${WORKER_TIMEOUT_MS}ms`))
        }, WORKER_TIMEOUT_MS)

        activeRequestsRef.current.set(id, {
          resolve,
          reject,
          signal,
          onAbort,
          timeoutId,
          cacheKey,
          onProgress: options?.onProgress,
        })
        setLoading(true)
        setError(null)
        setProgress({ percent: 0, currentMilestone: 'Queued', jobId: id })

        const { signal: _sig, priority: _prio, onProgress: _prog, bypassCache: _bpc, ...forwardOptions } = options || {}
        const requestMessage: WorkerRequest = {
          type: action,
          requestId: id,
          jobId: id,
          priority: options?.priority ?? 'NORMAL',
          payload: { cipherId, input, key, options: forwardOptions },
        }

        try {
          const payloadBuffer = new TextEncoder().encode(JSON.stringify(requestMessage))
          workerRef.current!.postMessage(payloadBuffer, [payloadBuffer.buffer])
        } catch (err) {
          clearTimeout(timeoutId)
          activeRequestsRef.current.delete(id)
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    },
    [fatalError]
  )

  return { runCipher, loading, error, progress }
}
