import type { ReportView } from '../shared/domain.js';
export interface ReportEditor {
  key: string;
  text: string;
  dirty: boolean;
  editVersion: number;
  baseDraftVersion: number;
}
export function isOlderReport(incoming: ReportView, known: ReportView | undefined): boolean {
  return Boolean(
    known &&
      (incoming.editVersion < known.editVersion || incoming.draftVersion < known.draftVersion),
  );
}
export function mergeSavedReport(
  editor: ReportEditor,
  acknowledgement: ReportView,
  known: ReportView | undefined,
  selectedKey: string,
) {
  const newerEdits = Boolean(known && known.editVersion > acknowledgement.editVersion);
  const report = known && isOlderReport(acknowledgement, known) ? known : acknowledgement;
  return {
    report,
    editor: { ...editor, dirty: newerEdits, editVersion: acknowledgement.editVersion },
    newerEdits,
    applyToCurrent: selectedKey === editor.key,
  };
}
