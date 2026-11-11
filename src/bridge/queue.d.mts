export declare const createSerialQueue: () => {
  run: <T>(task: () => Promise<T>) => Promise<T>
  readonly depth: number
}