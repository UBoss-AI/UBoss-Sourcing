/**
 * Medical device information — MDR (Regulation (EU) 2017/745).
 *
 * Kept apart from the GPSR panel next door even though a buyer reads them
 * together, because the two answer different questions and one of them has a
 * specific audience. A hospital's procurement team will not raise a purchase
 * order for a device without the class, the notified body number and a UDI to
 * put in their own asset register — and if the page does not carry them, that
 * becomes an email, a wait, and a lost order.
 *
 * Three display decisions:
 *
 *   - **Nothing renders for a product that is not a device.** Most of a
 *     catalogue is not, and an empty "Device information" heading would read
 *     as "a device with no certification", which is a far worse claim than
 *     silence.
 *
 *   - **The notified body is shown as `CE 0123`, the way it appears on the
 *     product.** A bare four-digit number in a table means nothing to somebody
 *     who has not memorised the convention; beside the CE mark it is instantly
 *     recognisable, and it is what they are checking the box against.
 *
 *   - **The two UDIs are labelled separately and never merged.** The Basic
 *     UDI-DI identifies the device group that the declaration of conformity is
 *     filed against; the UDI-DI identifies this packaging configuration and is
 *     what appears on the label. Showing one and calling it "the UDI" sends
 *     somebody looking for the other.
 */
import type { ProductDevice } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

/** The properties a buyer scans for, when they are true. */
function propertyKeys(device: ProductDevice): ('sterile' | 'singleUse' | 'measuring' | 'biological')[] {
  const keys: ('sterile' | 'singleUse' | 'measuring' | 'biological')[] = [];

  if (device.isSterile) keys.push('sterile');
  if (device.isSingleUse) keys.push('singleUse');
  if (device.hasMeasuringFunction) keys.push('measuring');
  if (device.containsBiologicalMaterial) keys.push('biological');

  return keys;
}

export function ProductDevicePanel({
  device,
}: {
  device: ProductDevice | null | undefined;
}): React.JSX.Element | null {
  const { t } = useI18n();

  // Most of a catalogue is not a device. Rendering a heading over nothing
  // would be a claim rather than an absence.
  if (device === null || device === undefined) return null;

  const properties = propertyKeys(device);

  return (
    <section aria-labelledby="device-heading" className="min-w-0">
      <h2 id="device-heading" className="text-title-sm text-ink">
        {t('device.heading')}
      </h2>

      <div className="mt-3 overflow-hidden rounded-lg border border-border bg-surface shadow-card">
        {device.intendedPurpose !== null && (
          <div className="border-b border-border-subtle px-4 py-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
              {t('device.intendedPurpose')}
            </h3>
            {/* Plain text with newlines kept, never markup - the same rule the
                safety warnings follow, and for the same reason. */}
            <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-ink">
              {device.intendedPurpose}
            </p>
          </div>
        )}

        <dl className="grid gap-x-6 gap-y-3 px-4 py-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
              {t('device.class')}
            </dt>
            <dd className="mt-0.5 text-ink">
              {t(`device.class.${device.deviceClass}` as 'device.class.CLASS_I')}
            </dd>
          </div>

          {device.notifiedBodyNumber !== null && (
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
                {t('device.notifiedBody')}
              </dt>
              {/* As it appears on the product, not as a bare number. */}
              <dd className="mt-0.5 font-mono text-ink">CE {device.notifiedBodyNumber}</dd>
            </div>
          )}

          {device.udiDi !== null && (
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
                {t('device.udiDi')}
              </dt>
              <dd className="mt-0.5 break-all font-mono text-xs text-ink">{device.udiDi}</dd>
            </div>
          )}

          {device.basicUdiDi !== null && (
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
                {t('device.basicUdiDi')}
              </dt>
              <dd className="mt-0.5 break-all font-mono text-xs text-ink">{device.basicUdiDi}</dd>
            </div>
          )}

          {device.manufacturerSrn !== null && (
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
                {t('device.eudamedSrn')}
              </dt>
              <dd className="mt-0.5 break-all font-mono text-xs text-ink">
                {device.manufacturerSrn}
              </dd>
            </div>
          )}
        </dl>

        {properties.length > 0 && (
          <ul className="flex flex-wrap gap-2 border-t border-border-subtle px-4 py-3">
            {properties.map((key) => (
              <li
                key={key}
                className="rounded-full bg-surface-sunken px-2.5 py-0.5 text-xxs font-medium text-ink-muted ring-1 ring-inset ring-border"
              >
                {t(`device.property.${key}` as 'device.property.sterile')}
              </li>
            ))}
          </ul>
        )}

        {device.declarationOfConformityUrl !== null && (
          <div className="border-t border-border-subtle px-4 py-3">
            <a
              className="text-sm font-semibold text-ink underline underline-offset-2 hover:no-underline"
              href={device.declarationOfConformityUrl}
              rel="noreferrer noopener"
              target="_blank"
            >
              {t('device.declaration')}
            </a>
          </div>
        )}
      </div>
    </section>
  );
}
