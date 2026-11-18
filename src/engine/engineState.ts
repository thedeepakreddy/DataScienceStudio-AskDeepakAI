/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Whether the compute engine is up, as the toolbar's engine status last saw it,
// so the agents' planner can prefer engine methods (AutoML) when it is.

export type EngineState = 'starting' | 'ready' | 'error';
let state: EngineState = 'starting';
export const getEngineState = () => state;
export const setEngineState = (s: EngineState) => { state = s; };
