/**
 * Photographs and videos on a listing.
 *
 * Two halves, because they answer different questions. The SLOTS are named -
 * front view, packaging, UDI label - because which photograph is which is
 * information a moderator and a buyer both use, and "add more photos" is not a
 * thing anybody can act on. The VIDEOS are a plain strip, because a video has
 * no equivalent of a front view: it is either there or it is not.
 *
 * Everything here uploads for real. A file is chosen or dropped, it goes up as
 * multipart, and the server decides from the BYTES whether it is a picture or a
 * clip - the browser's Content-Type is not trusted, and neither is the file
 * extension.
 *
 * One deliberate refusal: the main image can never be a video. It renders in a
 * search result and on an order confirmation, and neither of those can play
 * one.
 */
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, Field, Input } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import {
  deleteListingMedia,
  fetchListingMedia,
  updateListingMedia,
  uploadListingMedia,
  type DraftView,
  type ListingMedia,
  type SectionSummary,
} from '@/lib/seller';

/** What the seller is allowed to attach, said plainly rather than as MIME types. */
const ACCEPTED = 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime';

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export function ListingMediaPanel({
  draft,
  summary,
}: {
  draft: DraftView;
  summary: SectionSummary | null;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [uploadingSlot, setUploadingSlot] = useState<string | null>(null);

  const media = useQuery({
    queryKey: ['seller', 'draft', draft.id, 'media'],
    queryFn: () => fetchListingMedia(draft.id),
  });

  /** After any change, both the gallery and the draft's counters are stale. */
  const refresh = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: ['seller', 'draft', draft.id, 'media'] });
    await client.invalidateQueries({ queryKey: ['seller', 'draft', draft.id] });
  };

  const upload = useMutation({
    mutationFn: ({ file, slot }: { file: File; slot: string | null }) =>
      uploadListingMedia(draft.id, file, { slot }),
    onSuccess: async (uploaded) => {
      await refresh();
      toast.success(uploaded.kind === 'VIDEO' ? 'Video added.' : 'Photograph added.');
    },
    onError: (error: unknown) => {
      // The server's own sentence: it knows whether the refusal was the type,
      // the size, a duplicate or the count, and each has a different fix.
      toast.error(errorMessage(t, error, 'That file could not be uploaded.'));
    },
    onSettled: () => {
      setUploadingSlot(null);
    },
  });

  const remove = useMutation({
    mutationFn: (mediaId: string) => deleteListingMedia(draft.id, mediaId),
    onSuccess: async () => {
      await refresh();
      toast.success('Removed.');
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'That file could not be removed.'));
    },
  });

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof updateListingMedia>[2] }) =>
      updateListingMedia(draft.id, id, patch),
    onSuccess: refresh,
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'That could not be changed.'));
    },
  });

  /** One file into one slot. Shared by the file picker and the drop handler. */
  const send = (file: File | undefined, slot: string | null): void => {
    if (file === undefined) return;
    setUploadingSlot(slot ?? 'VIDEO');
    upload.mutate({ file, slot });
  };

  const slots = draft.schema?.mediaSlots ?? [];
  const rows = media.data?.media ?? [];
  const bySlot = new Map(rows.filter((row) => row.kind === 'IMAGE').map((row) => [row.slot, row]));
  const videos = rows.filter((row) => row.kind === 'VIDEO');

  return (
    <div className="space-y-5">
      <Card
        title="Product photos"
        description="Clear, well lit, on a plain background. No watermarks or contact details."
        actions={summary === null ? undefined : <SectionCount summary={summary} />}
      >
        <div className="px-6 py-5">
          <ul className="grid grid-cols-3 gap-3">
            {slots.map((slot) => {
              const existing = bySlot.get(slot.slot);
              const isBusy = upload.isPending && uploadingSlot === slot.slot;

              return (
                <li key={slot.slot}>
                  <SlotTile
                    label={slot.label}
                    isRequired={slot.isRequired}
                    media={existing ?? null}
                    isBusy={isBusy}
                    isDropTarget={dropTarget === slot.slot}
                    onPick={(file) => {
                      send(file, slot.slot);
                    }}
                    onDragStateChange={(active) => {
                      setDropTarget(active ? slot.slot : null);
                    }}
                    onMakePrimary={() => {
                      if (existing !== undefined) {
                        update.mutate({ id: existing.id, patch: { isPrimary: true } });
                      }
                    }}
                    onRemove={() => {
                      if (existing !== undefined) remove.mutate(existing.id);
                    }}
                  />
                </li>
              );
            })}
          </ul>

          {/* Alt text, only for what is actually there. An empty list of alt
              boxes above an empty gallery is noise. */}
          {rows.some((row) => row.kind === 'IMAGE') && (
            <div className="mt-5 space-y-3 border-t border-border-subtle pt-4">
              <h3 className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                Describe each photograph
              </h3>
              <p className="text-xxs leading-relaxed text-ink-muted">
                A short description of what is in the picture. Buyers using a screen reader rely on
                it, and it is what search engines read.
              </p>

              {rows
                .filter((row) => row.kind === 'IMAGE')
                .map((row) => (
                  <AltTextField
                    key={row.id}
                    media={row}
                    label={slots.find((slot) => slot.slot === row.slot)?.label ?? 'Photograph'}
                    onSave={(altText) => {
                      update.mutate({ id: row.id, patch: { altText } });
                    }}
                  />
                ))}
            </div>
          )}
        </div>
      </Card>

      {/* ---- Videos -------------------------------------------------------- */}
      <Card
        title="Product video"
        description="How it opens, how it fits, how it sounds — the questions a photograph cannot answer."
        actions={videos.length > 0 ? <Badge tone="brand">{videos.length}</Badge> : undefined}
      >
        <div className="space-y-3 px-6 py-5">
          {videos.map((video) => (
            <figure key={video.id} className="overflow-hidden rounded-lg border border-border">
              {/*
                eslint-disable-next-line jsx-a11y/media-has-caption --
                A caption track cannot exist here. The file is uploaded by a
                seller and nothing in this system can produce subtitles for it,
                so a `<track>` would have to point at something that does not
                exist. What the rule is protecting — somebody who cannot hear
                the video still learning what it shows — is served by the
                written description below, which is asked for directly and
                rendered as visible text rather than hidden in an attribute.
              */}
              <video
                src={video.url}
                controls
                preload="metadata"
                aria-describedby={`video-note-${video.id}`}
                className="aspect-video w-full bg-surface-sunken"
              >
                {/* A browser that cannot play it still offers the file. */}
                <a href={video.url}>Download the video</a>
              </video>

              <figcaption className="space-y-2 px-3 py-2">
                <p id={`video-note-${video.id}`} className="text-xs text-ink">
                  {video.altText === null || video.altText.length === 0 ? (
                    <span className="text-warning">
                      Describe what this video shows — buyers who cannot hear it rely on this.
                    </span>
                  ) : (
                    video.altText
                  )}
                </p>

                <AltTextField
                  media={video}
                  label="What the video shows"
                  onSave={(altText) => {
                    update.mutate({ id: video.id, patch: { altText } });
                  }}
                />

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xxs text-ink-subtle">
                    {humanSize(video.byteSize)}
                    {video.durationSeconds !== null && ` · ${String(video.durationSeconds)}s`}
                  </span>
                  <Button
                    size="sm"
                    disabled={remove.isPending}
                    onClick={() => {
                      remove.mutate(video.id);
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </figcaption>
            </figure>
          ))}

          <DropZone
            label={videos.length === 0 ? 'Add a video' : 'Add another video'}
            hint="MP4, WebM or MOV, up to 64 MB."
            isBusy={upload.isPending && uploadingSlot === 'VIDEO'}
            isDropTarget={dropTarget === 'VIDEO'}
            onPick={(file) => {
              send(file, null);
            }}
            onDragStateChange={(active) => {
              setDropTarget(active ? 'VIDEO' : null);
            }}
          />
        </div>
      </Card>
    </div>
  );
}

function SectionCount({ summary }: { summary: SectionSummary }): React.JSX.Element {
  const tone =
    summary.state === 'ERROR'
      ? 'danger'
      : summary.state === 'COMPLETE'
        ? 'success'
        : summary.state === 'OPTIONAL'
          ? 'neutral'
          : summary.state === 'IN_PROGRESS'
            ? 'warning'
            : 'neutral';

  return (
    <Badge tone={tone}>
      {summary.completed}/{summary.total}
    </Badge>
  );
}

/**
 * One named photograph slot.
 *
 * Filled, it shows the picture with the controls over it. Empty, it is a drop
 * target that also opens a file picker on click — both, because a seller on a
 * phone cannot drag anything and a seller with a folder of photographs should
 * not have to click through a dialog twelve times.
 */
function SlotTile({
  label,
  isRequired,
  media,
  isBusy,
  isDropTarget,
  onPick,
  onDragStateChange,
  onMakePrimary,
  onRemove,
}: {
  label: string;
  isRequired: boolean;
  media: ListingMedia | null;
  isBusy: boolean;
  isDropTarget: boolean;
  onPick: (file: File | undefined) => void;
  onDragStateChange: (active: boolean) => void;
  onMakePrimary: () => void;
  onRemove: () => void;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);

  if (media !== null) {
    return (
      <div
        className={cx(
          'group relative aspect-square overflow-hidden rounded-lg border',
          media.rejectionCode !== null ? 'border-danger' : 'border-border',
        )}
      >
        <img
          src={media.url}
          alt={media.altText ?? ''}
          className="h-full w-full bg-surface-media object-contain"
          loading="lazy"
        />

        {media.isPrimary && (
          <span className="absolute left-1.5 top-1.5 rounded-full bg-brand-fill px-2 py-0.5 text-xxs font-semibold text-white">
            Main
          </span>
        )}

        {/* Controls on hover at a pointer, and always visible under one -
            `group-hover` alone would hide them entirely on a touch screen. */}
        <div className="absolute inset-x-0 bottom-0 flex justify-between gap-1 bg-navy/70 p-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
          {!media.isPrimary && (
            <button
              type="button"
              onClick={onMakePrimary}
              className="rounded px-1.5 py-0.5 text-xxs font-medium text-white hover:bg-white/20"
            >
              Make main
            </button>
          )}
          <button
            type="button"
            onClick={onRemove}
            className="ml-auto rounded px-1.5 py-0.5 text-xxs font-medium text-white hover:bg-white/20"
          >
            Remove
          </button>
        </div>

        <span className="sr-only">{label}</span>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        disabled={isBusy}
        onClick={() => {
          inputRef.current?.click();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          onDragStateChange(true);
        }}
        onDragLeave={() => {
          onDragStateChange(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          onDragStateChange(false);
          onPick(event.dataTransfer.files[0]);
        }}
        className={cx(
          'flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-2 text-center transition-colors',
          isDropTarget
            ? 'border-brand bg-brand-soft'
            : isRequired
              ? 'border-border-strong bg-surface-sunken hover:border-brand/50'
              : 'border-border bg-surface-sunken hover:border-border-strong',
          isBusy && 'opacity-60',
        )}
      >
        <span aria-hidden="true" className="text-lg text-ink-subtle">
          {isBusy ? '…' : '+'}
        </span>
        <span className="text-xxs font-medium leading-tight text-ink-muted">{label}</span>
        {isRequired && <span className="text-xxs font-semibold text-danger">Required</span>}
      </button>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED}
        className="sr-only"
        onChange={(event) => {
          onPick(event.currentTarget.files?.[0]);
          // Cleared so choosing the SAME file again still fires a change event,
          // which is what a seller does after a failed upload.
          event.currentTarget.value = '';
        }}
      />
    </>
  );
}

/** A wide drop target, for videos and anything without a named slot. */
function DropZone({
  label,
  hint,
  isBusy,
  isDropTarget,
  onPick,
  onDragStateChange,
}: {
  label: string;
  hint: string;
  isBusy: boolean;
  isDropTarget: boolean;
  onPick: (file: File | undefined) => void;
  onDragStateChange: (active: boolean) => void;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <button
        type="button"
        disabled={isBusy}
        onClick={() => {
          inputRef.current?.click();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          onDragStateChange(true);
        }}
        onDragLeave={() => {
          onDragStateChange(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          onDragStateChange(false);
          onPick(event.dataTransfer.files[0]);
        }}
        className={cx(
          'flex w-full flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors',
          isDropTarget
            ? 'border-brand bg-brand-soft'
            : 'border-border bg-surface-sunken hover:border-border-strong',
          isBusy && 'opacity-60',
        )}
      >
        <span className="text-sm font-medium text-ink">{isBusy ? 'Uploading…' : label}</span>
        <span className="text-xxs text-ink-subtle">{hint}</span>
      </button>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED}
        className="sr-only"
        onChange={(event) => {
          onPick(event.currentTarget.files?.[0]);
          event.currentTarget.value = '';
        }}
      />
    </>
  );
}

/**
 * Alt text for one photograph, saved on blur.
 *
 * On blur rather than on every keystroke: a description is a sentence, and
 * saving it per character would be twenty writes for one caption.
 */
function AltTextField({
  media,
  label,
  onSave,
}: {
  media: ListingMedia;
  label: string;
  onSave: (altText: string) => void;
}): React.JSX.Element {
  const [value, setValue] = useState(media.altText ?? '');

  return (
    <Field label={label}>
      {({ inputId }) => (
        <Input
          id={inputId}
          value={value}
          placeholder="Zinc-plated hex bolt, viewed from the front"
          onChange={(event) => {
            setValue(event.currentTarget.value);
          }}
          onBlur={() => {
            if (value !== (media.altText ?? '')) onSave(value);
          }}
        />
      )}
    </Field>
  );
}
