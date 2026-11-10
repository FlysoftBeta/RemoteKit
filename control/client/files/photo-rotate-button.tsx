import { RotateRightOutlined } from '@mui/icons-material';
import { IconButton, Tooltip } from '@mui/material';
import type { LibraryEntry } from '../../shared/file-library';
import { useLibrary } from './file-library-state';
import type { PhotoDestination } from './photo-job-store';

export function PhotoRotateButton({
  entry,
  destination,
  disabled = false,
}: {
  entry: LibraryEntry;
  destination: PhotoDestination['destination'];
  disabled?: boolean;
}) {
  const { online, photos } = useLibrary();
  const job = photos.jobs.find((item) => item.replace?.id === entry.id);
  if (!entry.photo || entry.photo.pending || (job && job.rotationTurns === undefined)) return null;
  return (
    <Tooltip title="向右旋转">
      <span>
        <IconButton
          aria-label="向右旋转"
          disabled={disabled || !online || (!!job && job.state !== 'processing')}
          onClick={() => photos.rotate(entry, destination)}
        >
          <RotateRightOutlined fontSize="small" />
        </IconButton>
      </span>
    </Tooltip>
  );
}
