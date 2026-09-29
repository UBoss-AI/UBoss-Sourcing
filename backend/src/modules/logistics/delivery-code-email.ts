/**
 * The delivery-code email, in the buyer's own language.
 *
 * Worded here and handed to the outbox as {{subjectLine}} / {{bodyText}},
 * exactly as `buyer-companies/notifications.ts` does: the outbox templates are
 * one set of English strings, and a code a buyer has to read aloud to a driver
 * is the last message that should arrive in a language they do not read. The
 * language is the one they chose for the storefront (`users.preferredLanguage`)
 * and English where they never chose.
 *
 * What it says, and what it deliberately does not:
 *   - The code, the order and the consignment it is for, the carrier bringing
 *     it, and how long it works.
 *   - That it is given to the driver only once the goods are in front of them.
 *     A code read out over the telephone to somebody claiming to be the
 *     driver is exactly the fraud this whole control exists to stop.
 *   - Never the driver's name, the carrier's internal notes, or a link that
 *     would work without signing in.
 */
type Language = 'en' | 'pl' | 'de' | 'fr' | 'es' | 'it' | 'nl' | 'el';

export interface DeliveryCodeWords {
  name: string;
  /** The order number the buyer knows, or the consignment reference where there is no order. */
  order: string;
  shipment: string;
  carrier: string;
  code: string;
  hours: number;
}

type Message = (w: DeliveryCodeWords) => { subject: string; body: string };

const greeting: Record<Language, (name: string) => string> = {
  en: (name) => (name.length > 0 ? `Hello ${name},` : 'Hello,'),
  pl: (name) => (name.length > 0 ? `Dzień dobry ${name},` : 'Dzień dobry,'),
  de: (name) => (name.length > 0 ? `Guten Tag ${name},` : 'Guten Tag,'),
  fr: (name) => (name.length > 0 ? `Bonjour ${name},` : 'Bonjour,'),
  es: (name) => (name.length > 0 ? `Hola ${name}:` : 'Hola:'),
  it: (name) => (name.length > 0 ? `Gentile ${name},` : 'Buongiorno,'),
  nl: (name) => (name.length > 0 ? `Beste ${name},` : 'Goedendag,'),
  el: (name) => (name.length > 0 ? `Γεια σας ${name},` : 'Γεια σας,'),
};

const MESSAGES: Record<Language, Message> = {
  en: (w) => ({
    subject: `Delivery code for order ${w.order}: ${w.code}`,
    body:
      `${greeting.en(w.name)}\n\n` +
      `Consignment ${w.shipment} from order ${w.order} is out for delivery with ${w.carrier}. ` +
      `The driver will ask for this code to complete the delivery:\n\n    ${w.code}\n\n` +
      `Give it to the driver only when the goods are in front of you. Never read it out over the telephone or send it in a message, even to somebody who says they are the driver.\n\n` +
      `The code works for ${w.hours} hours. If a new code is sent, this one stops working.`,
  }),
  pl: (w) => ({
    subject: `Kod dostawy do zamówienia ${w.order}: ${w.code}`,
    body:
      `${greeting.pl(w.name)}\n\n` +
      `Przesyłka ${w.shipment} z zamówienia ${w.order} jest w doręczeniu przez ${w.carrier}. ` +
      `Kierowca poprosi o ten kod, aby zakończyć dostawę:\n\n    ${w.code}\n\n` +
      `Podaj go kierowcy dopiero wtedy, gdy towar jest przed Tobą. Nigdy nie podawaj go przez telefon ani w wiadomości, nawet komuś, kto przedstawia się jako kierowca.\n\n` +
      `Kod jest ważny przez ${w.hours} godz. Jeśli zostanie wysłany nowy kod, ten przestanie działać.`,
  }),
  de: (w) => ({
    subject: `Zustellcode für Bestellung ${w.order}: ${w.code}`,
    body:
      `${greeting.de(w.name)}\n\n` +
      `Die Sendung ${w.shipment} aus Bestellung ${w.order} ist mit ${w.carrier} in Zustellung. ` +
      `Der Fahrer fragt nach diesem Code, um die Zustellung abzuschließen:\n\n    ${w.code}\n\n` +
      `Geben Sie ihn dem Fahrer erst, wenn die Ware vor Ihnen liegt. Nennen Sie ihn nie am Telefon und senden Sie ihn nie in einer Nachricht, auch nicht an jemanden, der sich als Fahrer ausgibt.\n\n` +
      `Der Code ist ${w.hours} Stunden gültig. Wird ein neuer Code gesendet, verliert dieser seine Gültigkeit.`,
  }),
  fr: (w) => ({
    subject: `Code de livraison pour la commande ${w.order} : ${w.code}`,
    body:
      `${greeting.fr(w.name)}\n\n` +
      `L'envoi ${w.shipment} de la commande ${w.order} est en cours de livraison avec ${w.carrier}. ` +
      `Le livreur vous demandera ce code pour terminer la livraison :\n\n    ${w.code}\n\n` +
      `Ne le donnez au livreur que lorsque la marchandise est devant vous. Ne le communiquez jamais par téléphone ni par message, même à quelqu'un qui dit être le livreur.\n\n` +
      `Le code est valable ${w.hours} heures. Si un nouveau code est envoyé, celui-ci ne fonctionne plus.`,
  }),
  es: (w) => ({
    subject: `Código de entrega del pedido ${w.order}: ${w.code}`,
    body:
      `${greeting.es(w.name)}\n\n` +
      `El envío ${w.shipment} del pedido ${w.order} está en reparto con ${w.carrier}. ` +
      `El conductor le pedirá este código para completar la entrega:\n\n    ${w.code}\n\n` +
      `Déselo al conductor solo cuando tenga la mercancía delante. No lo diga nunca por teléfono ni lo envíe en un mensaje, ni siquiera a alguien que diga ser el conductor.\n\n` +
      `El código es válido durante ${w.hours} horas. Si se envía un código nuevo, este deja de funcionar.`,
  }),
  it: (w) => ({
    subject: `Codice di consegna per l'ordine ${w.order}: ${w.code}`,
    body:
      `${greeting.it(w.name)}\n\n` +
      `La spedizione ${w.shipment} dell'ordine ${w.order} è in consegna con ${w.carrier}. ` +
      `L'autista Le chiederà questo codice per completare la consegna:\n\n    ${w.code}\n\n` +
      `Lo comunichi all'autista solo quando la merce è davanti a Lei. Non lo dica mai al telefono e non lo invii in un messaggio, nemmeno a chi dice di essere l'autista.\n\n` +
      `Il codice è valido per ${w.hours} ore. Se viene inviato un nuovo codice, questo smette di funzionare.`,
  }),
  nl: (w) => ({
    subject: `Bezorgcode voor bestelling ${w.order}: ${w.code}`,
    body:
      `${greeting.nl(w.name)}\n\n` +
      `Zending ${w.shipment} van bestelling ${w.order} wordt vandaag bezorgd door ${w.carrier}. ` +
      `De chauffeur vraagt om deze code om de bezorging af te ronden:\n\n    ${w.code}\n\n` +
      `Geef hem pas aan de chauffeur als de goederen voor u staan. Noem hem nooit aan de telefoon en stuur hem nooit in een bericht, ook niet aan iemand die zegt de chauffeur te zijn.\n\n` +
      `De code is ${w.hours} uur geldig. Als er een nieuwe code wordt gestuurd, werkt deze niet meer.`,
  }),
  el: (w) => ({
    subject: `Κωδικός παράδοσης για την παραγγελία ${w.order}: ${w.code}`,
    body:
      `${greeting.el(w.name)}\n\n` +
      `Η αποστολή ${w.shipment} της παραγγελίας ${w.order} είναι καθ' οδόν για παράδοση με την ${w.carrier}. ` +
      `Ο οδηγός θα σας ζητήσει αυτόν τον κωδικό για να ολοκληρώσει την παράδοση:\n\n    ${w.code}\n\n` +
      `Δώστε τον στον οδηγό μόνο όταν τα προϊόντα βρίσκονται μπροστά σας. Μην τον λέτε ποτέ στο τηλέφωνο και μην τον στέλνετε σε μήνυμα, ακόμη και σε κάποιον που λέει ότι είναι ο οδηγός.\n\n` +
      `Ο κωδικός ισχύει για ${w.hours} ώρες. Αν σταλεί νέος κωδικός, αυτός παύει να ισχύει.`,
  }),
};

function languageOf(value: string | null | undefined): Language {
  return value !== null && value !== undefined && value in MESSAGES ? (value as Language) : 'en';
}

/** Word the email for one buyer. */
export function renderDeliveryCodeEmail(
  language: string | null | undefined,
  words: DeliveryCodeWords,
): { subject: string; body: string } {
  return MESSAGES[languageOf(language)](words);
}

/** The languages this file is written in. For the test that keeps them in step. */
export const DELIVERY_CODE_EMAIL_LANGUAGES = Object.keys(MESSAGES) as Language[];
