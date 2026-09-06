/**
 * The GPSR panel, tested for what it must not get wrong.
 *
 * This component is where the Art. 19 obligation is actually discharged — a
 * manufacturer recorded perfectly in the database and never rendered satisfies
 * nothing. So the cases here are the display ones: that the required facts
 * reach the page, and that an empty catalogue renders nothing rather than an
 * empty heading, which would read as "this product has no warnings".
 */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/harness';
import type { ProductSafety } from '@/lib/types';
import { ProductSafetyPanel } from './ProductSafetyPanel';

const MANUFACTURER = {
  legalName: 'Zorgproducten B.V.',
  tradeName: null,
  address: { line1: 'Industrieweg 1', city: 'Rotterdam', postalCode: '3011AA' },
  countryCode: 'NL',
  email: 'compliance@zorgproducten.test',
  phone: '+31 10 1234567',
  website: null,
};

const EU_REP = {
  legalName: 'EU Rep Services GmbH',
  tradeName: null,
  address: { line1: 'Hafenstraße 4', city: 'Hamburg', postalCode: '20457' },
  countryCode: 'DE',
  email: 'rep@eurep.test',
  phone: null,
  website: null,
};

const FULL: ProductSafety = {
  warnings: 'Single use only. Do not re-sterilise.',
  instructions: 'Inspect the packaging before use.',
  gtin: '05012345678900',
  modelIdentifier: 'AF-IV-200',
  manufacturer: MANUFACTURER,
  euResponsiblePerson: EU_REP,
};

const EMPTY: ProductSafety = {
  warnings: null,
  instructions: null,
  gtin: null,
  modelIdentifier: null,
  manufacturer: null,
  euResponsiblePerson: null,
};

describe('the product safety panel', () => {
  it('renders nothing when the catalogue carries no safety data', () => {
    renderWithProviders(<ProductSafetyPanel safety={EMPTY} />);

    // A heading over an empty block reads as "this product has no warnings",
    // which is a much stronger claim than "we have not stated any here".
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('renders nothing at all outside the EU, where the field is absent', () => {
    renderWithProviders(<ProductSafetyPanel safety={null} />);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();

    renderWithProviders(<ProductSafetyPanel safety={undefined} />);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('shows the warnings themselves', () => {
    renderWithProviders(<ProductSafetyPanel safety={FULL} />);

    expect(screen.getByText(/Do not re-sterilise/)).toBeInTheDocument();
    expect(screen.getByText(/Inspect the packaging/)).toBeInTheDocument();
  });

  it('names the manufacturer and gives a way to reach them', () => {
    renderWithProviders(<ProductSafetyPanel safety={FULL} />);

    expect(screen.getByText('Zorgproducten B.V.')).toBeInTheDocument();

    // Art. 19(a) asks for an electronic address specifically: a name and a
    // postal address with no way to write to them is the state the article
    // exists to stop.
    const email = screen.getByRole('link', { name: 'compliance@zorgproducten.test' });
    expect(email).toHaveAttribute('href', 'mailto:compliance@zorgproducten.test');
  });

  it('names the EU responsible person separately from the manufacturer', () => {
    renderWithProviders(<ProductSafetyPanel safety={FULL} />);

    // Two distinct legal roles. Rendering them as one "contact" block would
    // lose which company a market surveillance authority should write to.
    expect(screen.getByText('Zorgproducten B.V.')).toBeInTheDocument();
    expect(screen.getByText('EU Rep Services GmbH')).toBeInTheDocument();
  });

  it('shows the identifiers a recall notice would use', () => {
    renderWithProviders(<ProductSafetyPanel safety={FULL} />);

    expect(screen.getByText('AF-IV-200')).toBeInTheDocument();
    expect(screen.getByText('05012345678900')).toBeInTheDocument();
  });

  it('renders when only the warnings are filled in', () => {
    renderWithProviders(
      <ProductSafetyPanel safety={{ ...EMPTY, warnings: 'Keep away from heat.' }} />,
    );

    // A partial record still helps the reader, and hiding it until every field
    // is present would show less than the catalogue actually knows.
    expect(screen.getByText('Keep away from heat.')).toBeInTheDocument();
  });

  it('renders when only the manufacturer is filled in', () => {
    renderWithProviders(
      <ProductSafetyPanel safety={{ ...EMPTY, manufacturer: MANUFACTURER }} />,
    );

    expect(screen.getByText('Zorgproducten B.V.')).toBeInTheDocument();
  });

  it('does not render warning text as markup', () => {
    const { container } = renderWithProviders(
      <ProductSafetyPanel
        safety={{ ...EMPTY, warnings: '<img src=x onerror="alert(1)">Do not ingest.' }}
      />,
    );

    // Staff type this into a plain textarea, and a safety warning is the last
    // field in this application that should be able to carry HTML.
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(/Do not ingest/)).toBeInTheDocument();
  });
});
