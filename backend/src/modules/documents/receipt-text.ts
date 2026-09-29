/**
 * The words on a payment receipt, in each language the storefront speaks.
 *
 * Tax invoices and packing lists are issued in English (see
 * `document-format.ts`), because they are legal and customs documents. A
 * receipt is neither: it is the buyer's own acknowledgement that their money
 * arrived, or came back, and it is read by the buyer and their bookkeeper. So
 * it is printed in the language the buyer reads the shop in. Amounts are still
 * formatted from the stored minor-unit integer, never a float.
 *
 * `{marketplace}` in a sentence is the operator's trading name, filled in at
 * render time; no string here names this product.
 */
import type { SupportedLanguage } from '../identity/language.service.js';

export interface ReceiptText {
  paymentTitle: string;
  refundTitle: string;
  receiptNumber: string;
  issued: string;
  orderNumber: string;
  date: string;
  amount: string;
  status: string;
  statusPaid: string;
  statusRefunded: string;
  method: string;
  card: string;
  providerReference: string;
  originalPayment: string;
  receivedFrom: string;
  issuedBy: string;
  support: string;
  /** "Questions about this payment? Contact {marketplace} at {contact}." */
  supportLine: string;
  /** Printed under the amount. Not a tax invoice. */
  notInvoice: string;
  /** Receipt for a payment: the money was received. */
  paymentSentence: string;
  /** Receipt for a refund: the money was sent back. */
  refundSentence: string;
  unknown: string;
}

const TEXT: Record<SupportedLanguage, ReceiptText> = {
  en: {
    paymentTitle: 'PAYMENT RECEIPT',
    refundTitle: 'REFUND RECEIPT',
    receiptNumber: 'Receipt number',
    issued: 'Issued',
    orderNumber: 'Order number',
    date: 'Date and time',
    amount: 'Amount',
    status: 'Status',
    statusPaid: 'Paid',
    statusRefunded: 'Refunded',
    method: 'Payment method',
    card: 'Card',
    providerReference: 'Payment reference',
    originalPayment: 'Original payment reference',
    receivedFrom: 'Customer',
    issuedBy: 'Issued by',
    support: 'Support',
    supportLine: 'Questions about this payment? Contact {marketplace} at {contact} and quote the receipt number.',
    notInvoice: 'This receipt confirms a payment. It is not a tax invoice; the sellers issue those.',
    paymentSentence: '{marketplace} has received your payment for this order.',
    refundSentence: '{marketplace} has refunded this amount to the payment method you used.',
    unknown: 'Not recorded',
  },
  de: {
    paymentTitle: 'ZAHLUNGSBELEG',
    refundTitle: 'ERSTATTUNGSBELEG',
    receiptNumber: 'Belegnummer',
    issued: 'Ausgestellt',
    orderNumber: 'Bestellnummer',
    date: 'Datum und Uhrzeit',
    amount: 'Betrag',
    status: 'Status',
    statusPaid: 'Bezahlt',
    statusRefunded: 'Erstattet',
    method: 'Zahlungsart',
    card: 'Karte',
    providerReference: 'Zahlungsreferenz',
    originalPayment: 'Referenz der ursprünglichen Zahlung',
    receivedFrom: 'Kunde',
    issuedBy: 'Ausgestellt von',
    support: 'Kundendienst',
    supportLine: 'Fragen zu dieser Zahlung? Wenden Sie sich an {marketplace} unter {contact} und nennen Sie die Belegnummer.',
    notInvoice: 'Dieser Beleg bestätigt eine Zahlung. Er ist keine Steuerrechnung; diese stellen die Verkäufer aus.',
    paymentSentence: '{marketplace} hat Ihre Zahlung für diese Bestellung erhalten.',
    refundSentence: '{marketplace} hat diesen Betrag auf das verwendete Zahlungsmittel erstattet.',
    unknown: 'Nicht erfasst',
  },
  el: {
    paymentTitle: 'ΑΠΟΔΕΙΞΗ ΠΛΗΡΩΜΗΣ',
    refundTitle: 'ΑΠΟΔΕΙΞΗ ΕΠΙΣΤΡΟΦΗΣ ΧΡΗΜΑΤΩΝ',
    receiptNumber: 'Αριθμός απόδειξης',
    issued: 'Έκδοση',
    orderNumber: 'Αριθμός παραγγελίας',
    date: 'Ημερομηνία και ώρα',
    amount: 'Ποσό',
    status: 'Κατάσταση',
    statusPaid: 'Πληρώθηκε',
    statusRefunded: 'Επιστράφηκε',
    method: 'Τρόπος πληρωμής',
    card: 'Κάρτα',
    providerReference: 'Κωδικός αναφοράς πληρωμής',
    originalPayment: 'Κωδικός αναφοράς αρχικής πληρωμής',
    receivedFrom: 'Πελάτης',
    issuedBy: 'Εκδότης',
    support: 'Υποστήριξη',
    supportLine: 'Ερωτήσεις για αυτή την πληρωμή; Επικοινωνήστε με το {marketplace} στο {contact} αναφέροντας τον αριθμό απόδειξης.',
    notInvoice: 'Η απόδειξη αυτή επιβεβαιώνει μια πληρωμή. Δεν είναι φορολογικό τιμολόγιο· αυτά τα εκδίδουν οι πωλητές.',
    paymentSentence: 'Το {marketplace} έλαβε την πληρωμή σας για αυτή την παραγγελία.',
    refundSentence: 'Το {marketplace} επέστρεψε αυτό το ποσό στον τρόπο πληρωμής που χρησιμοποιήσατε.',
    unknown: 'Δεν καταγράφηκε',
  },
  es: {
    paymentTitle: 'RECIBO DE PAGO',
    refundTitle: 'RECIBO DE REEMBOLSO',
    receiptNumber: 'Número de recibo',
    issued: 'Emitido',
    orderNumber: 'Número de pedido',
    date: 'Fecha y hora',
    amount: 'Importe',
    status: 'Estado',
    statusPaid: 'Pagado',
    statusRefunded: 'Reembolsado',
    method: 'Método de pago',
    card: 'Tarjeta',
    providerReference: 'Referencia del pago',
    originalPayment: 'Referencia del pago original',
    receivedFrom: 'Cliente',
    issuedBy: 'Emitido por',
    support: 'Atención al cliente',
    supportLine: '¿Dudas sobre este pago? Contacte con {marketplace} en {contact} e indique el número de recibo.',
    notInvoice: 'Este recibo confirma un pago. No es una factura fiscal; esas las emiten los vendedores.',
    paymentSentence: '{marketplace} ha recibido su pago por este pedido.',
    refundSentence: '{marketplace} ha reembolsado este importe al método de pago que utilizó.',
    unknown: 'No registrado',
  },
  fr: {
    paymentTitle: 'REÇU DE PAIEMENT',
    refundTitle: 'REÇU DE REMBOURSEMENT',
    receiptNumber: 'Numéro de reçu',
    issued: 'Émis le',
    orderNumber: 'Numéro de commande',
    date: 'Date et heure',
    amount: 'Montant',
    status: 'Statut',
    statusPaid: 'Payé',
    statusRefunded: 'Remboursé',
    method: 'Moyen de paiement',
    card: 'Carte',
    providerReference: 'Référence du paiement',
    originalPayment: 'Référence du paiement initial',
    receivedFrom: 'Client',
    issuedBy: 'Émis par',
    support: 'Assistance',
    supportLine: 'Une question sur ce paiement ? Contactez {marketplace} à {contact} en indiquant le numéro de reçu.',
    notInvoice: "Ce reçu confirme un paiement. Ce n'est pas une facture fiscale ; celles-ci sont émises par les vendeurs.",
    paymentSentence: '{marketplace} a bien reçu votre paiement pour cette commande.',
    refundSentence: '{marketplace} a remboursé ce montant sur le moyen de paiement que vous avez utilisé.',
    unknown: 'Non enregistré',
  },
  it: {
    paymentTitle: 'RICEVUTA DI PAGAMENTO',
    refundTitle: 'RICEVUTA DI RIMBORSO',
    receiptNumber: 'Numero di ricevuta',
    issued: 'Emessa il',
    orderNumber: 'Numero d’ordine',
    date: 'Data e ora',
    amount: 'Importo',
    status: 'Stato',
    statusPaid: 'Pagato',
    statusRefunded: 'Rimborsato',
    method: 'Metodo di pagamento',
    card: 'Carta',
    providerReference: 'Riferimento del pagamento',
    originalPayment: 'Riferimento del pagamento originale',
    receivedFrom: 'Cliente',
    issuedBy: 'Emessa da',
    support: 'Assistenza',
    supportLine: 'Domande su questo pagamento? Contatta {marketplace} all’indirizzo {contact} indicando il numero di ricevuta.',
    notInvoice: 'Questa ricevuta conferma un pagamento. Non è una fattura fiscale; quelle le emettono i venditori.',
    paymentSentence: '{marketplace} ha ricevuto il tuo pagamento per questo ordine.',
    refundSentence: '{marketplace} ha rimborsato questo importo sul metodo di pagamento che hai usato.',
    unknown: 'Non registrato',
  },
  nl: {
    paymentTitle: 'BETALINGSBEWIJS',
    refundTitle: 'BEWIJS VAN TERUGBETALING',
    receiptNumber: 'Bewijsnummer',
    issued: 'Uitgegeven',
    orderNumber: 'Bestelnummer',
    date: 'Datum en tijd',
    amount: 'Bedrag',
    status: 'Status',
    statusPaid: 'Betaald',
    statusRefunded: 'Terugbetaald',
    method: 'Betaalmethode',
    card: 'Kaart',
    providerReference: 'Betalingsreferentie',
    originalPayment: 'Referentie van de oorspronkelijke betaling',
    receivedFrom: 'Klant',
    issuedBy: 'Uitgegeven door',
    support: 'Klantenservice',
    supportLine: 'Vragen over deze betaling? Neem contact op met {marketplace} via {contact} en vermeld het bewijsnummer.',
    notInvoice: 'Dit bewijs bevestigt een betaling. Het is geen belastingfactuur; die worden door de verkopers uitgegeven.',
    paymentSentence: '{marketplace} heeft uw betaling voor deze bestelling ontvangen.',
    refundSentence: '{marketplace} heeft dit bedrag teruggestort op de betaalmethode die u gebruikte.',
    unknown: 'Niet vastgelegd',
  },
  pl: {
    paymentTitle: 'POTWIERDZENIE PŁATNOŚCI',
    refundTitle: 'POTWIERDZENIE ZWROTU',
    receiptNumber: 'Numer potwierdzenia',
    issued: 'Wystawiono',
    orderNumber: 'Numer zamówienia',
    date: 'Data i godzina',
    amount: 'Kwota',
    status: 'Status',
    statusPaid: 'Opłacono',
    statusRefunded: 'Zwrócono',
    method: 'Metoda płatności',
    card: 'Karta',
    providerReference: 'Numer referencyjny płatności',
    originalPayment: 'Numer referencyjny pierwotnej płatności',
    receivedFrom: 'Klient',
    issuedBy: 'Wystawca',
    support: 'Obsługa klienta',
    supportLine: 'Pytania dotyczące tej płatności? Skontaktuj się z {marketplace} pod adresem {contact}, podając numer potwierdzenia.',
    notInvoice: 'To potwierdzenie dotyczy płatności. Nie jest fakturą VAT; faktury wystawiają sprzedawcy.',
    paymentSentence: '{marketplace} otrzymał Twoją płatność za to zamówienie.',
    refundSentence: '{marketplace} zwrócił tę kwotę na użytą metodę płatności.',
    unknown: 'Nie odnotowano',
  },
};

export function receiptText(language: SupportedLanguage): ReceiptText {
  return TEXT[language];
}

/** Every language has every key - checked by the unit test. */
export const RECEIPT_LANGUAGES = Object.keys(TEXT) as SupportedLanguage[];

/** Replace `{name}` placeholders. Values are inserted as plain text. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}
