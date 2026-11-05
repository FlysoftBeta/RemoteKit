export interface BasketDrag {
  id: string;
  ids: string[];
  revision: number;
}

export function basketDragCurrent(drag: BasketDrag, ids: string[], revision: number) {
  return (
    drag.revision === revision &&
    drag.ids.length === ids.length &&
    drag.ids.every((id, index) => id === ids[index])
  );
}

export function basketDrop(
  drag: BasketDrag | null,
  over: string | undefined,
  ids: string[],
  revision: number,
) {
  if (!drag || !over || over === drag.id || !basketDragCurrent(drag, ids, revision)) return;
  const from = ids.indexOf(drag.id),
    to = ids.indexOf(over);
  if (from < 0 || to < 0) return;
  const reordered = [...ids];
  reordered.splice(from, 1);
  reordered.splice(to, 0, drag.id);
  return { ids: reordered, revision: drag.revision };
}
