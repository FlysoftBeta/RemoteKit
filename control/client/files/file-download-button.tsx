import DownloadOutlined from '@mui/icons-material/DownloadOutlined';
import { IconButton, Snackbar, Tooltip } from '@mui/material';
import { useState } from 'react';
import type { LibraryFileEntry } from '../../shared/file-library';
import type { RemoteKitError } from '../../shared/errors';
import { FailureNote, failureError } from '../failures';
import { useLibrary } from './file-library-state';

export function FileDownloadButton({ entry, disabled }: { entry: LibraryFileEntry; disabled: boolean }) {
  const { download } = useLibrary();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RemoteKitError>();
  return (
    <>
      <Tooltip title="下载到本地">
        <span onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
          <IconButton
            size="small"
            aria-label={`下载到本地 ${entry.name}`}
            disabled={disabled || busy}
            sx={{ bgcolor: 'background.paper' }}
            onClick={async () => {
              setBusy(true);
              try {
                await download(entry);
              } catch (cause) {
                setError(failureError(cause));
              } finally {
                setBusy(false);
              }
            }}
          >
            <DownloadOutlined fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Snackbar open={!!error} onClose={() => setError(undefined)}>
        {error ? (
          <div>
            <FailureNote
              error={error}
              context={{ operation: '下载到本地', scope: 'item', targetId: entry.id }}
            />
          </div>
        ) : undefined}
      </Snackbar>
    </>
  );
}
