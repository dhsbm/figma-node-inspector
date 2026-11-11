export type ReorderStep = {index: number; id: string}

export declare const planMove: (
  currentIds: string[],
  nodeId: string,
  index: number,
) => {desired: string[]; target: number}

export declare const planReorder: (
  currentIds: string[],
  desiredIds: string[],
) => ReorderStep[]

export declare const assertPermutation: (
  before: string[],
  after: string[],
) => boolean