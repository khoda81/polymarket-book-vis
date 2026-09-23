import { PRICE_SCALE, type Price, priceFromTicks } from "./price";

/**
 * Immutable weighted AVL tree for one side of the order book in side-local
 * price coordinates.
 *
 * Every stored level has a non-negative share weight. The pressure frontier is
 * not stored separately: Q(u) is the suffix sum of all level weights at
 * coordinates >= u. Consequently Q is non-increasing by construction.
 */
export interface FrontierNode {
  readonly key: Price;
  readonly weight: number;
  readonly sum: number;
  readonly height: number;
  readonly left: FrontierNode | null;
  readonly right: FrontierNode | null;
}

export type FrontierRoot = FrontierNode | null;

export interface FrontierLevel {
  readonly key: Price;
  readonly weight: number;
}

export function frontierLevel(root: FrontierRoot, key: Price): number {
  validateKey(key);
  let node = root;
  while (node) {
    if (key === node.key) return node.weight;
    node = key < node.key ? node.left : node.right;
  }
  return 0;
}

export function setFrontierLevel(
  root: FrontierRoot,
  key: Price,
  weight: number,
): FrontierRoot {
  validateKey(key);
  validateWeight(weight);
  return setNode(root, key, weight);
}

/** Cumulative shares at side-local coordinate u. */
export function frontierVolumeAt(root: FrontierRoot, u: Price): number {
  if (u <= 0) return root?.sum ?? 0;

  let node = root;
  let sum = 0;
  while (node) {
    if (u <= node.key) {
      sum += node.weight + (node.right?.sum ?? 0);
      node = node.left;
    } else {
      node = node.right;
    }
  }
  return sum;
}

/**
 * Constant pressure inside a canonical price interval bounded by book levels.
 * Use its edges: two adjacent floats need not have a representable midpoint.
 * Compare asks in canonical coordinates so 1 - (1 - price) cannot move a
 * query onto the other side of an ask boundary.
 */
export function frontierVolumeOnInterval(
  root: FrontierRoot,
  side: "bid" | "ask",
  lo: Price,
  hi: Price,
): number {
  let node = root;
  let sum = 0;
  while (node) {
    const included =
      side === "bid" ? node.key >= hi : node.key >= PRICE_SCALE - lo;
    if (included) {
      sum += node.weight + (node.right?.sum ?? 0);
      node = node.left;
    } else {
      node = node.right;
    }
  }
  return sum;
}

/** Allow only floating-point summation-order noise when checking totals. */
export function sameFrontierVolume(a: number, b: number): boolean {
  return Math.abs(a - b) <= 32 * Number.EPSILON * Math.max(1, a, b);
}

export function frontierLevels(root: FrontierRoot): FrontierLevel[] {
  const result: FrontierLevel[] = [];
  const stack: FrontierNode[] = [];
  let node = root;

  while (node || stack.length > 0) {
    while (node) {
      stack.push(node);
      node = node.left;
    }
    node = stack.pop()!;
    result.push({ key: node.key, weight: node.weight });
    node = node.right;
  }
  return result;
}

export function buildFrontier(levels: readonly FrontierLevel[]): FrontierRoot {
  let root: FrontierRoot = null;
  for (const { key, weight } of levels)
    root = setFrontierLevel(root, key, weight);
  return root;
}

function setNode(node: FrontierRoot, key: Price, weight: number): FrontierRoot {
  if (!node) return weight > 0 ? makeNode(key, weight, null, null) : null;

  if (key === node.key) {
    if (!(weight > 0)) return join(node.left, node.right);
    if (weight === node.weight) return node;
    return makeNode(key, weight, node.left, node.right);
  }

  if (key < node.key) {
    const left = setNode(node.left, key, weight);
    if (left === node.left) return node;
    return rebalance(makeNode(node.key, node.weight, left, node.right));
  }

  const right = setNode(node.right, key, weight);
  if (right === node.right) return node;
  return rebalance(makeNode(node.key, node.weight, node.left, right));
}

function join(left: FrontierRoot, right: FrontierRoot): FrontierRoot {
  if (!left) return right;
  if (!right) return left;

  if (height(left) > height(right) + 1)
    return rebalance(
      makeNode(left.key, left.weight, left.left, join(left.right, right)),
    );

  if (height(right) > height(left) + 1)
    return rebalance(
      makeNode(right.key, right.weight, join(left, right.left), right.right),
    );

  const [successor, nextRight] = removeMin(right);
  return rebalance(makeNode(successor.key, successor.weight, left, nextRight));
}

function removeMin(node: FrontierNode): readonly [FrontierNode, FrontierRoot] {
  if (!node.left) return [node, node.right];

  const [minimum, left] = removeMin(node.left);
  return [
    minimum,
    rebalance(makeNode(node.key, node.weight, left, node.right)),
  ];
}

function rebalance(node: FrontierNode): FrontierNode {
  const balance = height(node.left) - height(node.right);

  if (balance > 1) {
    const left = node.left!;
    if (height(left.left) < height(left.right))
      return rotateRight(
        makeNode(node.key, node.weight, rotateLeft(left), node.right),
      );
    return rotateRight(node);
  }

  if (balance < -1) {
    const right = node.right!;
    if (height(right.right) < height(right.left))
      return rotateLeft(
        makeNode(node.key, node.weight, node.left, rotateRight(right)),
      );
    return rotateLeft(node);
  }

  return node;
}

function rotateLeft(node: FrontierNode): FrontierNode {
  const right = node.right!;
  return makeNode(
    right.key,
    right.weight,
    makeNode(node.key, node.weight, node.left, right.left),
    right.right,
  );
}

function rotateRight(node: FrontierNode): FrontierNode {
  const left = node.left!;
  return makeNode(
    left.key,
    left.weight,
    left.left,
    makeNode(node.key, node.weight, left.right, node.right),
  );
}

function makeNode(
  key: Price,
  weight: number,
  left: FrontierRoot,
  right: FrontierRoot,
): FrontierNode {
  return {
    key,
    weight,
    sum: weight + (left?.sum ?? 0) + (right?.sum ?? 0),
    height: 1 + Math.max(height(left), height(right)),
    left,
    right,
  };
}

function height(node: FrontierRoot): number {
  return node?.height ?? 0;
}

function validateKey(key: Price): void {
  priceFromTicks(key);
}

function validateWeight(weight: number): void {
  if (!Number.isFinite(weight) || weight < 0)
    throw new RangeError("frontier weight must be finite and non-negative");
}
