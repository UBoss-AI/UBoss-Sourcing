/**
 * Notification templates (Master row 76): the admin list joins the events an
 * operator has customised with every built-in event at its defaults.
 */
export interface SettingRow {
  eventKey: string;
  name: string;
  emailEnabled: boolean;
  smsEnabled: boolean;
  whatsappEnabled: boolean;
  inAppEnabled: boolean;
  whatsappTemplate: string | null;
  subjectTemplate: string;
  bodyTemplate: string;
  isActive: boolean;
}

export interface CatalogueRow {
  eventKey: string;
  subject: string;
  body: string;
}

export interface NotificationEventView extends SettingRow {
  customised: boolean;
}

/** The customised rows, plus every built-in event at its defaults. */
export function mergeEvents(rows: SettingRow[], catalogue: CatalogueRow[]): NotificationEventView[] {
  const byKey = new Map<string, NotificationEventView>();
  for (const entry of catalogue) {
    byKey.set(entry.eventKey, {
      eventKey: entry.eventKey,
      name: entry.eventKey,
      emailEnabled: true,
      smsEnabled: false,
      whatsappEnabled: false,
      inAppEnabled: true,
      whatsappTemplate: null,
      subjectTemplate: entry.subject,
      bodyTemplate: entry.body,
      isActive: true,
      customised: false,
    });
  }
  for (const row of rows) byKey.set(row.eventKey, { ...row, customised: true });
  return [...byKey.values()].sort((a, b) => a.eventKey.localeCompare(b.eventKey));
}
