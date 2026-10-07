/**
 * The page's moving background: ghost fibers behind every screen.
 *
 * KEPT BYTE-IDENTICAL across apps/customer-web, apps/admin-web,
 * apps/logistics-web and apps/audit-web.
 *
 * Fixed to the window and stacked under everything (`-z-10` on the root
 * stacking context), so it shows wherever a screen has no ground of its own
 * and is covered by every card, bar and panel that does. Nothing on a page
 * needs to know it is there.
 *
 * Two renderings, following the theme in force rather than the preference:
 *
 *   - Dark: the original look - indigo strands with a blue glow on a
 *     near-black ground.
 *   - Light: blue strands on the light theme's pale blue ground
 *     (`--surface-sunken`): a wash of blue and sky that drifts across it, a
 *     haze of the same tints along each strand, and the strands' cores in
 *     the brand blue (#3437A0). The shader holds every pixel at or above 62%
 *     relative luminance by lifting it toward a light blue (#9BD7FF), so the
 *     strands stay blue rather than washing out to white. That keeps --ink
 *     and --ink-muted (page titles and subtitles) at 4.5:1 or better
 *     anywhere on the page; the smallest grey (--ink-subtle) and blue links
 *     drawn straight on the page can dip to about 4:1 where a strand's core
 *     passes under them. Text on cards is unaffected.
 *
 * Cheap on purpose, because it runs behind every screen all day: thirty frames
 * a second, a drawing buffer at three quarters of the CSS size (the strands
 * are soft, so it does not show), and no frames at all while the tab is hidden
 * or the visitor asked for less motion.
 */
import { useTheme } from '@/app/theme-context';
import { GhostFibers } from '@/components/GhostFibers';

export function PageBackdrop(): React.JSX.Element {
  const { resolved } = useTheme();
  const light = resolved === 'light';

  return (
    <div aria-hidden="true" className="page-backdrop pointer-events-none fixed inset-0 -z-10">
      <GhostFibers
        lightMode={light}
        lineColor={light ? '#3437A0' : '#140E35'}
        glowColor="#3437A0"
        backdrop={light ? '#EEF3FD' : '#120F17'}
        fiberStrength={1}
        tintA="#60A5FA"
        tintB="#38BDF8"
        tint={light ? 1 : 0}
        lumaFloor={light ? 0.62 : 0}
        liftColor="#9BD7FF"
        // The light rendering cannot get darker than its floor, so it is made
        // visible by area instead: thicker strands, a wider glow round each,
        // and less fade toward the edges of the window. Dark keeps the original.
        lineSharpness={light ? 8 : 16}
        glowFalloff={light ? 6 : 10}
        glowIntensity={light ? 2.2 : 1.6}
        vignette={light ? 0.45 : 0.8}
        fps={30}
        dpr={0.75}
      />
    </div>
  );
}
