/**
 * Department marks for the category strip.
 *
 * `category-icons.tsx` draws the *shelf*: a cannula, a Ryles tube, an ENFit
 * syringe. This file draws the *department*: the twenty-five headings a
 * catalogue is filed under, plus the "all products" bag that starts the strip.
 * Two sets, because they answer two different questions — "what is in this
 * box?" and "which aisle am I in?" — and an aisle sign drawn at the same
 * weight as a product picture reads as a product.
 *
 * WHY THESE ARE TWO-TONE WHEN EVERYTHING ELSE IS ONE
 *
 * The strip is the widest, flattest row on the page: twenty-six shapes at
 * 28px in a single line. A row of twenty-six single-weight stroke drawings at
 * that size is a picket fence — every item weighs exactly the same, so the eye
 * has nothing to catch on and the row is read left to right like text, which
 * is the slowest way to use it.
 *
 * So each mark carries one filled accent in the brand colour, and only one:
 * the part of the object that says what it is. The cross on the medical case,
 * the liquid in the flask, the screen of the phone, the cushion of the sofa.
 * Filled shapes read at a glance where outlines do not, and having exactly one
 * per mark keeps the row a row rather than twenty-six competing pictures.
 *
 * The accent is `fill-brand`, a token, so it re-tints in dark mode along with
 * everything else. It is deliberately NOT a literal colour: this is a product
 * other companies run, the brand blue is theirs to change in `index.css`, and
 * a hard-coded hue here would be the one row of the storefront that ignored
 * them.
 *
 * THE RULES THIS SET KEEPS
 *
 *   - **One viewBox, one stroke weight.** `0 0 24 24` and 1.6 — a shade
 *     lighter than `category-icons.tsx`'s 1.7, because these carry a filled
 *     shape as well and the two together at 1.7 go muddy at 28px.
 *   - **Line work is `currentColor`.** So a mark inherits the ink colour of
 *     the item it sits in, and the active item's mark darkens with its label
 *     without a second class.
 *   - **The accent is drawn first.** It is underneath the outline, the way a
 *     printed two-colour mark is, so the stroke stays crisp over it.
 *   - **Always `aria-hidden`.** The department's name is right beneath it.
 *
 * They are drawn rather than downloaded, for the reasons `icons.tsx` sets out:
 * a stroke icon takes the theme in both modes, costs no request, carries no
 * licence, and scales to any size. `lib/department-mark.ts` decides which
 * department gets which one.
 */

interface IconProps {
  className?: string;
}

/** The shared frame. Every mark in this file is this `<svg>` and nothing else. */
function Mark({
  className = 'h-6 w-6',
  children,
}: IconProps & { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/**
 * The one filled shape in a mark.
 *
 * A component rather than a class on each `<path>`, so "the accent is the
 * brand colour and has no stroke" is stated once. A second accent in a mark is
 * a mark that has stopped following the rule at the top of this file.
 */
function Accent({ d }: { d: string }): React.JSX.Element {
  return <path d={d} className="fill-brand" stroke="none" />;
}

export type DepartmentMark = (props: IconProps) => React.JSX.Element;

// ---------------------------------------------------------------------------
// The strip's first item
// ---------------------------------------------------------------------------

/**
 * Everything, as a shopping bag.
 *
 * The strip opens with it the way a shop opens with a door. The accent is the
 * crescent inside the bag rather than the bag itself: a solid bag at 28px is a
 * blob, and the crescent is what makes it read as open and empty — which is
 * what "all products" is.
 */
export function AllProductsIcon(props: IconProps): React.JSX.Element {
  return (
    <Mark {...props}>
      <Accent d="M8.5 11.2c.5 2.5 1.8 3.8 3.5 3.8s3-1.3 3.5-3.8c.1-.55-.4-.95-.9-.72a6.4 6.4 0 0 1-5.2 0c-.5-.23-1 .17-.9.72Z" />
      <path d="M5.4 7.6h13.2l-1 11.6a1.6 1.6 0 0 1-1.6 1.4H8a1.6 1.6 0 0 1-1.6-1.4Z" />
      <path d="M9 7.6V6a3 3 0 0 1 6 0v1.6" />
    </Mark>
  );
}

// ---------------------------------------------------------------------------
// Health, laboratory, safety, hygiene
// ---------------------------------------------------------------------------

/** Medical Devices: a carry case with a cross on it. */
export function MedicalDevicesIcon(props: IconProps): React.JSX.Element {
  return (
    <Mark {...props}>
      <Accent d="M11 10.6h2v2.2h2.2v2h-2.2V17h-2v-2.2H8.8v-2H11Z" />
      <rect x="3" y="7.4" width="18" height="12.6" rx="2" />
      <path d="M9.4 7.4V6a1.6 1.6 0 0 1 1.6-1.6h2A1.6 1.6 0 0 1 14.6 6v1.4" />
    </Mark>
  );
}

/** Laboratory & Scientific: a conical flask with something in it. */
export function LaboratoryIcon(props: IconProps): React.JSX.Element {
  return (
    <Mark {...props}>
      <Accent d="M7.5 14.6h9l1.9 3.3a1.8 1.8 0 0 1-1.6 2.7H7.2a1.8 1.8 0 0 1-1.6-2.7Z" />
      <path d="M9.4 3.2h5.2" />
      <path d="M10.2 3.2v5.6l-4.6 9.1a1.8 1.8 0 0 0 1.6 2.7h9.6a1.8 1.8 0 0 0 1.6-2.7l-4.6-9.1V3.2" />
    </Mark>
  );
}

/** Safety & Protective Equipment: a hard hat. */
export function SafetyIcon(props: IconProps): React.JSX.Element {
  return (
    <Mark {...props}>
      <Accent d="M12 5.2a4.8 4.8 0 0 1 4.8 4.8v3.4H7.2V10A4.8 4.8 0 0 1 12 5.2Z" />
      <path d="M7.2 13.4V10a4.8 4.8 0 0 1 9.6 0v3.4" />
      <path d="M3.6 13.4h16.8a1.5 1.5 0 0 1 0 3H3.6a1.5 1.5 0 0 1 0-3Z" />
      <path d="M10 5.9V4.4h4v1.5" />
    </Mark>
  );
}

/** Cleaning & Hygiene: a trigger spray, half full. */
export function CleaningIcon(props: IconProps): React.JSX.Element {
  return (
    <Mark {...props}>
      <Accent d="M8.4 13.2h6v5.6a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2Z" />
      <path d="M8.4 7h6v11.8a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2Z" />
      <path d="M9.6 7V3.8h4V7" />
      <path d="M13.6 4.6h4.2" />
      <path d="M19.4 3.2h.02M19.4 6h.02M21.4 4.6h.02" />
    </Mark>
  );
}

// ---------------------------------------------------------------------------
// Industry, trade, materials
// ---------------------------------------------------------------------------

/**
 * Industrial Supplies: a gear.
 *
 * The teeth are a real toothed outline rather than eight spokes radiating from
 * a circle. Spokes were tried and the mark read as a sun at 24px, which is the
 * failure mode of every gear icon drawn that way: a tooth has width, and
 * without it the eye sees rays.
 */
export function IndustrialIcon(props: IconProps): React.JSX.Element {
  return (
    <Mark {...props}>
      <Accent d="M12 9.2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6Z" />
      <path d="M10.33 1.94A10.2 10.2 0 0 1 13.67 1.94L14.91 4.98A7.6 7.6 0 0 1 16.42 5.82L17.93 3.7A10.2 10.2 0 0 1 20.3 6.07L19.02 9.09A7.6 7.6 0 0 1 19.5 10.75L22.06 10.33A10.2 10.2 0 0 1 22.06 13.67L19.02 14.91A7.6 7.6 0 0 1 18.18 16.42L20.3 17.93A10.2 10.2 0 0 1 17.93 20.3L14.91 19.02A7.6 7.6 0 0 1 13.25 19.5L13.67 22.06A10.2 10.2 0 0 1 10.33 22.06L9.09 19.02A7.6 7.6 0 0 1 7.58 18.18L6.07 20.3A10.2 10.2 0 0 1 3.7 17.93L4.98 14.91A7.6 7.6 0 0 1 4.5 13.25L1.94 13.67A10.2 10.2 0 0 1 1.94 10.33L4.98 9.09A7.6 7.6 0 0 1 5.82 7.58L3.7 6.07A10.2 10.2 0 0 1 6.07 3.7L9.09 4.98A7.6 7.6 0 0 1 10.75 4.5Z" />
      <circle cx="12" cy="12" r="4.4" />
    </Mark>
  );
}

/**
 * Tools & Hardware: a spanner over a screwdriver.
 *
 * A claw hammer was drawn here first and read as a letter T — which is what a
 * hammer is at 24px once the claw stops resolving. Two crossed tools do not
 * have that problem: the diagonal is the shape, and it survives any size the
 * strip asks for.
 */
export function ToolsIcon(props: IconProps): React.JSX.Element {
  return (
    <Mark {...props}>
      <Accent d="M19.9 3.3a4.9 4.9 0 0 1-5.7 6.9l-1.6-1.6a4.9 4.9 0 0 1 4.8-5.9Z" />
      <path d="M16.7 3a4.9 4.9 0 0 0-3.8 7.1L4.6 18.4a2 2 0 1 0 2.8 2.8l8.3-8.3A4.9 4.9 0 0 0 21 7.1l-2.7 2.7-2.9-.8-.8-2.9Z" />
      <path d="M3.4 4.6 6.2 3l11.4 11.4a2 2 0 0 1-2.8 2.8Z" />
    </Mark>
  );
}

/**
 * Building & Construction: a brick wall, one brick laid.
 *
 * Loose courses, not a framed grid. A rectangle with lines ruled across it
 * reads as a window at 24px, which is the wrong end of the building trade; the
 * gaps between the bricks are what make it masonry.
 */
export function BuildingIcon(props: IconProps): React.JSX.Element {
  return (
    <Mark {...props}>
      <Accent d="M3.2 10.4h8.2v3.4H3.2Z" />
      <path d="M3.2 4.6h5.2v3.4H3.2ZM9.4 4.6h5.2v3.4H9.4ZM15.6 4.6h5.2v3.4h-5.2Z" />
      <path d="M3.2 10.4h8.2v3.4H3.2ZM12.4 10.4h8.4v3.4h-8.4Z" />
      <path d="M3.2 16.2h5.2v3.4H3.2ZM9.4 16.2h5.2v3.4H9.4ZM15.6 16.2h5.2v3.4h-5.2Z" />
    </Mark>
  );
}

/** Chemicals & Raw Materials: a drum with a drop on it. */
export function ChemicalsIcon(props: IconProps): React.JSX.Element {
  return (
    <Mark {...props}>
      <Accent d="M12 10.6c1.7 2.1 2.6 3.7 2.6 4.8a2.6 2.6 0 0 1-5.2 0c0-1.1.9-2.7 2.6-4.8Z" />
      <path d="M5.6 6.4c0-1.5 2.9-2.8 6.4-2.8s6.4 1.3 6.4 2.8v11.2c0 1.5-2.9 2.8-6.4 2.8s-6.4-1.3-6.4-2.8Z" />
      <path d="M5.6 6.4c0 1.5 2.9 2.8 6.4 2.8s6.4-1.3 6.4-2.8" />
    </Mark>
  );
}

/** Energy & Environment: a bolt, ringed. */
export function EnergyIcon(props: IconProps): React.JSX.Element {
  return (
    <Mark {...props}>
      <Accent d="M12.8 3.4 7.6 12.6h3.4L10.4 20.6l5.8-9.6h-3.6Z" />
      <path d="M12.8 3.4 7.6 12.6h3.4L10.4 20.6l5.8-9.6h-3.6Z" />
      <path d="M4.6 6.2a9.4 9.4 0 0 0-.4 10.4M19.4 6.2a9.4 9.4 0 0 1 .4 10.4" />
    </Mark>
  );
}

// ---------------------------------------------------------------------------
// Electrical and electronic
// ---------------------------------------------------------------------------

/**
 * Electrical & Lighting: a lamp.
 *
 * The accent is the screw base, not the glass. Filling the glass made a solid
 * disc — the one shape a bulb must not be, because a bulb is read by its
 * outline and the base is what tells it apart from a balloon.
 */
export function ElectricalIcon(props: IconProps): React.JSX.Element {
  return (
    <Mark {...props}>
      <Accent d="M9.4 17.4h5.2v1.8H9.4ZM10.2 20.2h3.6V22h-3.6Z" />
      <path d="M12 2.6a6.4 6.4 0 0 1 3.9 11.5c-.8.6-1.3 1.5-1.3 2.4v.9H9.4v-.9c0-.9-.5-1.8-1.3-2.4A6.4 6.4 0 0 1 12 2.6Z" />
      <path d="M9.4 19.2h5.2M10.2 22h3.6" />
    </Mark>
  );
}

/** Electronics & Components: a chip. */
export function ElectronicsIcon(props: IconProps): React.JSX.Element {
  return (
    <Mark {...props}>
      <Accent d="M9.6 9.6h4.8v4.8H9.6Z" />
      <rect x="6" y="6" width="12" height="12" rx="1.6" />
      <path d="M9.4 6V3.4M12 6V3.4M14.6 6V3.4M9.4 20.6V18M12 20.6V18M14.6 20.6V18" />
      <path d="M6 9.4H3.4M6 12H3.4M6 14.6H3.4M20.6 9.4H18M20.6 12H18M20.6 14.6H18" />
    </Mark>
  );
}

/** Computers & IT: a laptop. */
export function ComputersIcon(props: IconProps): React.JSX.Element {
  return (
    <Mark {...props}>
      <Accent d="M2.6 17.2h18.8l-.9 1.8a1.6 1.6 0 0 1-1.4.9H4.9a1.6 1.6 0 0 1-1.4-.9Z" />
      <rect x="4.6" y="4.4" width="14.8" height="10.2" rx="1.4" />
      <path d="M2.6 17.2h18.8l-.9 1.8a1.6 1.6 0 0 1-1.4.9H4.9a1.6 1.6 0 0 1-1.4-.9Z" />
    </Mark>
  );
}

/** Phones & Communication: a handset. */
export function PhonesIcon(props: IconProps): React.JSX.Element {
  return (
    <Mark {...props}>
      <Accent d="M8.8 7.6h6.4v8.2H8.8Z" />
      <rect x="6.8" y="2.6" width="10.4" height="18.8" rx="2.2" />
      <path d="M10.4 5.4h3.2" />
      <path d="M12 18.4h.02" />
    </Mark>
  );
}

// ---------------------------------------------------------------------------
// The workplace
// ---------------------------------------------------------------------------

/** Office & Stationery: a pencil. */
export function OfficeIcon(props: IconProps): React.JSX.Element {
  return (
    <Mark {...props}>
      <Accent d="m6.2 14.6 8.8-8.8 3 3-8.8 8.8Z" />
      <path d="M4 20l1.4-4.6L15.4 5.4a2 2 0 0 1 2.8 0l1 1a2 2 0 0 1 0 2.8L9 19.4l-5 .6Z" />
      <path d="m14.4 6.4 3.2 3.2" />
    </Mark>
  );
}

/**
 * Packaging & Shipping: a taped carton.
 *
 * The tape runs across the flaps, not down the front. A vertical band down a
 * square made the mark a wrapped present, which is a different department in
 * most catalogues and a misleading one in this.
 */
export function PackagingIcon(props: IconProps): React.JSX.Element {
  return (
    <Mark {...props}>
      <Accent d="M3.2 7.6h17.6v4H3.2Z" />
      <path d="M3.2 7.6h17.6v11a1.6 1.6 0 0 1-1.6 1.6H4.8a1.6 1.6 0 0 1-1.6-1.6Z" />
      <path d="M3.2 11.6h17.6" />
      <path d="M12 7.6v4" />
      <path d="M7.4 4.2 12 7.6l4.6-3.4" />
    </Mark>
  );
}

/** Furniture & Fixtures: a sofa. */
export function FurnitureIcon(props: IconProps): React.JSX.Element {
  return (
    <Mark {...props}>
      <Accent d="M4.6 12.4h14.8a2 2 0 0 1 2 2v2.4H2.6v-2.4a2 2 0 0 1 2-2Z" />
      <path d="M5.4 12.4V8.6a2 2 0 0 1 2-2h9.2a2 2 0 0 1 2 2v3.8" />
      <path d="M2.6 16.8v-2.4a2 2 0 0 1 2-2h14.8a2 2 0 0 1 2 2v2.4Z" />
      <path d="M5 16.8v2M19 16.8v2" />
    </Mark>
  );
}

// ---------------------------------------------------------------------------
// Transport, land, catering, home
// ---------------------------------------------------------------------------

/** Automotive & Transport: a delivery van. */
export function AutomotiveIcon(props: IconProps): React.JSX.Element {
  return (
    <Mark {...props}>
      <Accent d="M3.6 7.4h8.2v8.2H3.6Z" />
      <path d="M2.6 8.4a1.4 1.4 0 0 1 1.4-1.4h7.8v9.2H2.6Z" />
      <path d="M11.8 10.4h3.6l3.4 3.4v2.4h-7Z" />
      <circle cx="7" cy="17.8" r="1.8" />
      <circle cx="16.4" cy="17.8" r="1.8" />
    </Mark>
  );
}

/** Agriculture & Gardening: a seedling. */
export function AgricultureIcon(props: IconProps): React.JSX.Element {
  return (
    <Mark {...props}>
      <Accent d="M11.2 13.6C8.4 13.6 5.4 11.4 5.4 7.8c3.6 0 5.8 2.6 5.8 5.8Z" />
      <Accent d="M12.8 13.6c0-3.2 2.2-5.8 5.8-5.8 0 3.6-3 5.8-5.8 5.8Z" />
      <path d="M11.2 13.6C8.4 13.6 5.4 11.4 5.4 7.8c3.6 0 5.8 2.6 5.8 5.8Z" />
      <path d="M12.8 13.6c0-3.2 2.2-5.8 5.8-5.8 0 3.6-3 5.8-5.8 5.8Z" />
      <path d="M12 20.6v-7.2" />
      <path d="M5.2 20.6h13.6" />
    </Mark>
  );
}

/** Food Service & Catering: a serving cloche. */
export function FoodServiceIcon(props: IconProps): React.JSX.Element {
  return (
    <Mark {...props}>
      <Accent d="M4 16a8 8 0 0 1 16 0Z" />
      <path d="M4 16a8 8 0 0 1 16 0" />
      <path d="M2.6 16h18.8a1.3 1.3 0 0 1 0 2.6H2.6a1.3 1.3 0 0 1 0-2.6Z" />
      <path d="M12 8V6.4" />
      <circle cx="12" cy="5" r="1.2" />
    </Mark>
  );
}

/** Home & Kitchen: a cooking pot. */
export function HomeKitchenIcon(props: IconProps): React.JSX.Element {
  return (
    <Mark {...props}>
      <Accent d="M4.8 11.4h14.4v4.8a3.4 3.4 0 0 1-3.4 3.4H8.2a3.4 3.4 0 0 1-3.4-3.4Z" />
      <path d="M4.8 9.8h14.4v6.4a3.4 3.4 0 0 1-3.4 3.4H8.2a3.4 3.4 0 0 1-3.4-3.4Z" />
      <path d="M19.2 11.2h1.6a1.2 1.2 0 0 1 0 2.4h-1.6M4.8 11.2H3.2a1.2 1.2 0 0 0 0 2.4h1.6" />
      <path d="M3.6 9.8h16.8" />
      <path d="M12 7.8V6.2" />
    </Mark>
  );
}

// ---------------------------------------------------------------------------
// Consumer
// ---------------------------------------------------------------------------

/** Clothing & Textiles: a t-shirt. */
export function ClothingIcon(props: IconProps): React.JSX.Element {
  return (
    <Mark {...props}>
      <Accent d="M7.8 14h8.4v4.6a1.6 1.6 0 0 1-1.6 1.6H9.4a1.6 1.6 0 0 1-1.6-1.6Z" />
      <path d="M8.8 3.6 4.8 5.4 3 9.4l3 1.4 1.2-1.9v9.7a1.6 1.6 0 0 0 1.6 1.6h6.4a1.6 1.6 0 0 0 1.6-1.6V8.9l1.2 1.9 3-1.4-1.8-4-4-1.8a3.4 3.4 0 0 1-6.4 0Z" />
    </Mark>
  );
}

/** Beauty & Personal Care: a lipstick. */
export function BeautyIcon(props: IconProps): React.JSX.Element {
  return (
    <Mark {...props}>
      <Accent d="M9.2 9.6V4.8l5.6-2.4v7.2Z" />
      <path d="M9.2 9.6V4.8l5.6-2.4v7.2Z" />
      <path d="M8.4 9.6h7.2v3.2H8.4Z" />
      <path d="M8.8 12.8h6.4v7.4a1.4 1.4 0 0 1-1.4 1.4h-3.6a1.4 1.4 0 0 1-1.4-1.4Z" />
    </Mark>
  );
}

/** Sports & Outdoors: a football. */
export function SportsIcon(props: IconProps): React.JSX.Element {
  return (
    <Mark {...props}>
      <Accent d="m12 8.2 3.2 2.3-1.2 3.8h-4l-1.2-3.8Z" />
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 3.4v4.8M19.2 9.4l-4 2.9M16.4 18.1l-1.6-4.6M7.6 18.1l1.6-4.6M4.8 9.4l4 2.9" />
    </Mark>
  );
}

/** Toys, Hobbies & Crafts: a bear. */
export function ToysIcon(props: IconProps): React.JSX.Element {
  return (
    <Mark {...props}>
      <Accent d="M12 9.8a2.1 2.1 0 0 1 0 4.2 2.1 2.1 0 0 1 0-4.2Z" />
      <circle cx="7.2" cy="6" r="2.2" />
      <circle cx="16.8" cy="6" r="2.2" />
      <circle cx="12" cy="9.6" r="4.4" />
      <path d="M12 14.2c3.3 0 5.6 2.3 5.6 4.6 0 1.9-2.3 2.9-5.6 2.9s-5.6-1-5.6-2.9c0-2.3 2.3-4.6 5.6-4.6Z" />
    </Mark>
  );
}

/** Books & Media: a book with a marker in it. */
export function BooksIcon(props: IconProps): React.JSX.Element {
  return (
    <Mark {...props}>
      <Accent d="M13.4 2.8h3.4v7.4l-1.7-1.4-1.7 1.4Z" />
      <path d="M5 4.6a1.8 1.8 0 0 1 1.8-1.8h11.4a1 1 0 0 1 1 1v15.6a1 1 0 0 1-1 1H6.8A1.8 1.8 0 0 1 5 18.6Z" />
      <path d="M5 18.2h13.6" />
    </Mark>
  );
}

// ---------------------------------------------------------------------------
// The unrecognised case
// ---------------------------------------------------------------------------

/**
 * A department this file has never heard of.
 *
 * Not a question mark and not a blank: a filed folder, which is what an
 * unnamed department genuinely is. The rule in `icons.tsx` still holds — a
 * literal picture beside a department nobody has described is worse than no
 * picture — and a folder claims nothing about what is inside it.
 */
export function DepartmentIcon(props: IconProps): React.JSX.Element {
  return (
    <Mark {...props}>
      <Accent d="M3.4 10.6h17.2v7.4a1.6 1.6 0 0 1-1.6 1.6H5a1.6 1.6 0 0 1-1.6-1.6Z" />
      <path d="M3.4 7a1.6 1.6 0 0 1 1.6-1.6h4.2l2 2.4h7.8A1.6 1.6 0 0 1 20.6 9.4V18a1.6 1.6 0 0 1-1.6 1.6H5A1.6 1.6 0 0 1 3.4 18Z" />
      <path d="M3.4 10.6h17.2" />
    </Mark>
  );
}
