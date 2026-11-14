export type Rotation = 0 | 90 | 180 | 270;

export type PropValue = number | string | boolean;
export type Props = Readonly<Record<string, PropValue>>;

export interface Component {
  readonly id: string;
  readonly type: string;
  /** Grid-snapped world position of the component's local origin. */
  readonly x: number;
  readonly y: number;
  readonly rot: Rotation;
  readonly label: string;
  readonly props: Props;
}

export interface PinRef {
  readonly comp: string;
  readonly pin: string;
}

/** A wire joins two pins into one net. It has no direction; `from` is the driving end when there is one. */
export interface Wire {
  readonly id: string;
  readonly from: PinRef;
  readonly to: PinRef;
  /** Optional user-adjusted coordinate of the wire's middle segment. */
  readonly mid?: number;
}

/** Immutable circuit document. Every edit returns a new object and shares what did not change. */
export interface Circuit {
  /** Stable id within the project, e.g. "main" or "k3". Subcircuit parts have type `sub:<id>`. */
  readonly id: string;
  readonly name: string;
  readonly nextId: number;
  readonly components: Readonly<Record<string, Component>>;
  readonly wires: Readonly<Record<string, Wire>>;
}

/** A project: several circuits, any of which can be used inside another as a subcircuit. */
export interface Project {
  readonly name: string;
  readonly main: string;
  /** Circuits in the order shown in the sidebar. */
  readonly circuits: readonly Circuit[];
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const GRID = 10;
