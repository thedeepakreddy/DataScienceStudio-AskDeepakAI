/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';
import type { RunRecord } from '../utils/workspaceStore';

export type RunInput = Omit<RunRecord, 'id' | 'createdAt' | 'versionId'>;

/**
 * Lets any stage record an analysis run in the saved history. The App binds it
 * to the dataset version that is active, so each run carries its provenance.
 */
export const WorkspaceContext = createContext<{ logRun: (run: RunInput) => void }>({
  logRun: () => {},
});

export const useLogRun = () => useContext(WorkspaceContext).logRun;
