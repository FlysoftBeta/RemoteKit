# Files, basket and photo processing contract

Control owns the catalog, groups, basket ordering and native `files` tabs. Endpoint owns immutable, Session-scoped SHA-256 assets, temporary uploads and image processing. No shared path or clock is required. Clients persist no file/product state. File bytes use the existing authenticated reliable RTC channel and its file worker.

## Endpoint RPC / RTC

`session.files.authorize` gains `library: true`; this enables only library methods with `params.requestId: "library"` on the current unlocked peer/auth epoch, separately from chooser grants. Revoke/rebind invalidates both. `files.request` / `files.result` envelopes remain version 1.

Library RTC methods (all params include requestId):
- `asset.begin {operationId,name,type,size}` -> `{uploadId,offset}` (idempotent operation ID, bounded draft).
- `asset.chunk {uploadId,offset,data}` -> `{offset}` (existing 16KiB base64 rules).
- `asset.seal {uploadId}` -> `Asset`.
- `asset.cancel {uploadId}` -> `{cancelled:true}`.
- `asset.read {assetId,offset}` -> `{data,offset,total}` (at most 16KiB).
- `asset.describe {assetId}` -> `Asset`; authorized Session-local metadata, no filesystem paths.
- `photo.burst.begin/sample/end/cancel` performs incremental Endpoint assessment of bounded analysis images. The client retains matching original snapshots; stop at sufficient quality or a 1-second/20-distinct-frame ceiling, then upload only the selected PNG and genuinely uncertain alternative. Exact wire and resource limits: [camera pipeline](camera-pipeline-contract.md).
- `photo.rank {assetIds}` remains a legacy batch endpoint, at most six images and three uncertain candidates. The production camera uses incremental burst assessment instead.
- `photo.process {assetId,mode:"rectify"|"scan",corners?:[{x,y}]}` -> PNG `Asset` plus `geometry:"perspective"|"deskew"|"unchanged"`. Normalized clockwise corners optional. The new UI exposes only a single color scan mode: supported page perspective or conservative text-direction correction, followed by color-preserving illumination enhancement. Missing page edges do not fail a scan or justify invented cropping. Legacy rectify still explicitly fails without reliable geometry. Original immutable asset survives; processing is bounded to8Mi pixels/64MiB compressed input.
- `photo.thumbnail {assetId}` -> `Asset`; a temporary content-addressed JPEG, at most320 pixels on the longest edge and64KiB, read through asset.read. WIC downsizes JPEG/PNG before RGB allocation, source at most64MiB/32Mi pixels/16384 per axis. Session cache has at most256 source mappings. Client lazily requests visible thumbnails with bounded concurrency/cache; unsupported images keep an honest file placeholder.
- `selection.commit {selectionId}` (real chooser requestId) -> `{state,selectionId}`. Never replays a submitted native callback.

`Asset = {assetId:string,hash:string,size:number,type:string,width?:number,height?:number}`. The hash is computed over actual bytes by Endpoint. Names live in Control and are separately validated for native staging. A hash never grants cross-Session access. Raw unreferenced uploads are bounded and expire; referenced assets survive restarts.

Control-only Endpoint commands:
- `session.library.describe {assetId}` -> Asset; verifies local existence.
- `session.library.retain {assetIds}` -> `{accepted:true}`; mark catalog assets retained (idempotent).
- `session.library.references {revision,assetIds}` -> `{accepted:true}`; reconcile the full Control reference set in monotonically increasing catalog revision order. Include original images and unresolved selections. Removed unarchived basket entries are pruned only when no unresolved selection refers to them; unreferenced assets become expiring drafts, not immediate deletions.
- `session.library.prepare {selectionId,binding,files:[{assetId,name,type}],requestId}` -> `{accepted:true}`; immutable selection manifest bound to native chooser identity, persisted before side effects.
- `session.library.selectionStatus {selectionId}` -> `{state:"pending"|"validating"|"selected"|"cancelled"|"unknown"}`. Reads terminal receipts even after chooser grant retirement. Never resubmits. On native selected confirmation persist terminal receipt, then Control can consume basket entries. Unknown after process loss remains unknown, not assumed success.

A retired chooser cancels a durable pending selection only if the callback has never been claimed. The transition checks the expected pending state atomically against submission. Once submitted, a missing native receipt remains unknown and retains its references; retirement alone cannot prove cancellation.

Browser `page.reply` accepts bounded `selection_id` and its file status echoes the exact token. Endpoint must match it before recording selected. This terminal means handing files to the native listener, not proof that the website has uploaded them to its own server.

Copies/hardlinks used for native selections live independently from library entries until confirmed Browser incarnation exit. Storage limits apply before writes and decode allocation; do not hold media/Browser locks during hashing, disk copy or OpenCV. Existing legacy file APIs remain compatible.

## Control API / shared types

`control/shared/file-library.ts` owns exported types and `LibraryMethods` merged into SocketMethods. `LibrarySnapshot = {revision,entries:LibraryEntry[],basket:string[],groups:{id,name}[]}`; `LibraryEntry = {id,assetId,name,type,size,createdAt,groupId:string|null,archived:boolean,originalAssetId?:string,photo?:PhotoMetadata}`. Photo metadata records mode, up to2 candidate asset IDs, optional pending choice/scan-error and a bounded warning. All candidate references are retained; pending photos cannot be prepared for native selection. Basket uses unique entry IDs, max64. Catalog max4096. `archived` means visible in My Files; temporary basket imports are not archived until page selection succeeds. Direct My Files imports are archived immediately.

- `library.get {}` -> snapshot
- `library.import {operationId,assetId,name,destination:"basket"|"library",groupId:string|null,originalAssetId?:string,afterId?:string}` -> snapshot; Endpoint describe/retain verified before durable metadata. Idempotent operationId.
- Import also accepts optional `photo` metadata. `library.replace {operationId,entryId,expectedRevision,assetId,originalAssetId?,photo?}` replaces assets and photo metadata in place, preserving identity/order/name/time/group/archive state. It checks the idempotent receipt before revision, rejects unresolved native selections and reconciles original/candidate references. Retry the same operation and frozen payload after a lost response.
- `library.basket {operationId,expectedRevision,ids:string[]}` -> snapshot; replace exact order with known catalog entries; reject stale catalog revision after checking an idempotent replay. This prevents stale reorder/append from reinserting a concurrently consumed item or dropping a newly imported one. Removal does not delete archived files. Max64, duplicates rejected.
- `library.group {operationId,id?:string,name:string}` -> snapshot; create or rename.
- `library.move {operationId,ids:string[],groupId:string|null}` -> snapshot.
- `library.delete {operationId,ids:string[]}` -> snapshot; explicit confirmed deletion, at most64. Removes catalog and basket entries; rejects entries owned by an unresolved native selection. Idempotent retries succeed without recreating deleted entries. Reconcile references afterward; shared content and Browser staging remain independent, unreferenced content is reclaimed after its grace period.
- `library.prepare {operationId,requestId,entryIds:string[],groupId:string|null}` -> `{selectionId}`; validates native multiple/count/size, records immutable selection and group; instruct Endpoint prepare. Same operation resumes same selection.
- `library.finish {selectionId}` -> `{state,snapshot}`; Endpoint terminal confirmation only; atomically archive selected entries and remove exactly those basket IDs, once. Repeat safe. Reconcile pending selections on library.get too. No removal on cancelled/unknown. Group picker is offered on each upload/selection if groups exist, with explicit ungrouped choice.

`ProductTab.kind` extends with `files`, action `tab.files {windowId}` creates/activates singleton per Window. Native view creation, lifecycle, navigation and media visibility treat files like start; opening a real URL converts to remote normally.

## UX

Only camera and basket are primary surfaces. Full-screen cover preview with matching output crop, portrait bottom shutter and landscape side shutter; photo/color-scan mode and continuous toggle are configured in-camera. A shutter creates a bounded provider task and basket placeholder; no mandatory review/save screen. Sampling completion releases the shutter while upload/processing continues. Only uncertain photos require inline candidate selection; retake preserves the old entry until the replacement is ready and confirmed. Files and photos share one ordered basket with drag reorder, insert-after and remove. Single-file chooser requires explicit radio choice; multiple submits all in basket order and blocks while items are unresolved. Native accept remains a hint, not a new security filter.

Image-heavy collections use horizontal cards with whole-card drag (no handle) and click-to-open menus. Touch swipe browses the strip; long press starts reorder. Clearly ordinary-file-heavy collections default to a list with drag handles and directly visible action buttons. One button manually switches the view, held only for that component instance. A drag previews locally and commits once on changed drop, using the captured catalog revision; cancel/disconnect/authoritative changes cannot silently submit stale order. Photo slots share this interaction. My Files preserves chronological order and does not pretend its archive can be manually reordered. Detailed visual and input behavior: [UX specification](file-library-ux.md).

The compact basket is a horizontal strip with send/add/more icons vertically on the right. Candidate, preview, groups and source selection expand within the basket. My Files remains an actual product tab, newest first, with group filters, upload, create/rename group, move files and add to basket. Show group selection each time once groups exist. Only confirmed Browser selection consumes entries. Photo processing sends camera samples/drafts to Endpoint before final page submission; UI does not claim local-only processing.

Anchor only to native supplied input bounds with valid document/layout identity. The native source tracks the actual visible main-frame input and revokes its rectangle when absent; subframe inputs fall back until coordinate transformation is supported. This is asynchronously updated geometry, not physical-frame synchronization. Without a usable anchor use a compact Dialog; do not infer from last click. Overlay does not affect remote content bounds. Full-screen camera independent of this anchor.
