import test from 'node:test';
import assert from 'node:assert/strict';
import { fileChooserAccept, selectionViewModel, validateSelection } from '../client/files/file-selection';
import { selectVisibility } from '../client/app/visibility';
import type { FileRequest, ProductState } from '../shared/product';
const request: FileRequest = {
  id: 'opaque',
  tabId: 'a',
  windowId: 'w',
  origin: 'https://example.test',
  multiple: false,
  accept: ['.JPG', 'image/png'],
  state: 'pending',
  limits: { maxFiles: 3, maxFileBytes: 100, maxBatchBytes: 150 },
};

test('chooser cancellation preserves claimed outcomes until terminal reconciliation', () => {
  assert.equal(selectionViewModel('unknown', 'selected').selected, true);
  assert.equal(selectionViewModel('unknown', 'selected').cancelled, false);
  assert.equal(selectionViewModel('pending', 'unknown').uncertain, true);
  assert.equal(selectionViewModel('unknown', 'unknown').terminal, false);
  assert.equal(selectionViewModel('validating', 'validating').terminal, false);
  assert.equal(selectionViewModel('selected', 'unknown').selected, true);
  assert.equal(selectionViewModel('selected', 'unknown').uncertain, false);
  assert.equal(selectionViewModel('cancelled', 'unknown').cancelled, true);
});

test('omitted file hints do not restrict selection to an incomplete accept list', () => {
  assert.deepEqual(fileChooserAccept(request), request.accept);
  const partial = { ...request, accept: ['application/pdf'], acceptTypesOmitted: true };
  assert.deepEqual(fileChooserAccept(partial), []);
  assert.equal(validateSelection([new File(['bytes'], 'unlisted.txt')], partial), '');
  assert.deepEqual(partial.accept, ['application/pdf']);
});
test('file selection respects multiple and size limits', () => {
  const a = new File(['data'], 'a.jpg', { type: 'image/jpeg', lastModified: 1 }),
    b = new File(['data'], 'b.png', { type: 'image/png', lastModified: 1 });
  assert.equal(validateSelection([a], request), '');
  assert.match(validateSelection([a, b], request), /数量/);
  assert.match(validateSelection([new File([new Uint8Array(101)], 'large.jpg')], request), /单个/);
});
test('one foreground modal uses active visible window; background requests wait', () => {
  const state = {
    workspace: {
      layoutMode: 'side-by-side',
      activeWindowId: 'w2',
      windows: [
        { id: 'w1', activeTabId: 'a' },
        { id: 'w2', activeTabId: 'b' },
      ],
    },
    pageDialogs: [{ id: 'page', tabId: 'a' }],
    fileRequests: [{ ...request, id: 'file', tabId: 'b' }],
  } as unknown as ProductState;
  assert.deepEqual(selectVisibility(state, 1440).foreground, { kind: 'file', id: 'file' });
  state.fileRequests = [];
  assert.deepEqual(selectVisibility(state, 1440).foreground, { kind: 'page', id: 'page' });
  assert.equal(selectVisibility(state, 390).foreground, null);
});
