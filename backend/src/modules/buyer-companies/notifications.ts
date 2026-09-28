/**
 * The emails a buyer company receives about its verification, in the
 * recipient's own language.
 *
 * The outbox and its templates have no language (`notification.service.ts`
 * is one set of English strings), so these messages are worded here and
 * handed to it as {{subjectLine}} / {{bodyText}}. The language is the one
 * the person chose for the storefront (`users.preferredLanguage`), and
 * English where they never chose.
 *
 * What an email may contain, and what it may not:
 *   - The company's name, the application reference, and a link to the
 *     signed-in application page. The link carries the company's opaque id
 *     and nothing else - never a registration number, a tax number or a
 *     document - and it only opens after sign-in.
 *   - A reviewer's reason or request, because the applicant needs it to act.
 *     Internal notes never reach this file.
 */
import { env } from '../../config/env.js';
import { prisma } from '../../infra/prisma.js';
import { NotificationEvent, enqueueNotification } from '../notifications/notification.service.js';

type Language = 'en' | 'pl' | 'de' | 'fr' | 'es' | 'it' | 'nl' | 'el';

export type CompanyEmailKind =
  | 'EMAIL_CODE'
  | 'SUBMITTED'
  | 'REVIEW_STARTED'
  | 'INFO_REQUESTED'
  | 'APPROVED'
  | 'REJECTED'
  | 'SUSPENDED'
  | 'REVERIFICATION'
  | 'RESTORED';

interface Words {
  name: string;
  company: string;
  reference: string;
  url: string;
  code: string;
  email: string;
  reason: string;
  /** Whether a rejected applicant may correct it and send it again. */
  canResubmit: boolean;
}

type Message = (w: Words) => { subject: string; body: string };

const EVENT: Record<CompanyEmailKind, string> = {
  EMAIL_CODE: NotificationEvent.BUYER_COMPANY_EMAIL_CODE,
  SUBMITTED: NotificationEvent.BUYER_COMPANY_SUBMITTED,
  REVIEW_STARTED: NotificationEvent.BUYER_COMPANY_REVIEW_STARTED,
  INFO_REQUESTED: NotificationEvent.BUYER_COMPANY_INFO_REQUESTED,
  APPROVED: NotificationEvent.BUYER_COMPANY_APPROVED,
  REJECTED: NotificationEvent.BUYER_COMPANY_REJECTED,
  SUSPENDED: NotificationEvent.BUYER_COMPANY_SUSPENDED,
  REVERIFICATION: NotificationEvent.BUYER_COMPANY_REVERIFICATION,
  RESTORED: NotificationEvent.BUYER_COMPANY_RESTORED,
};

const MESSAGES: Record<Language, Record<CompanyEmailKind, Message>> = {
  en: {
    EMAIL_CODE: (w) => ({
      subject: `Your code for ${w.company}: ${w.code}`,
      body: `Enter this code to confirm ${w.email} as the business email of ${w.company}:\n\n    ${w.code}\n\nIt works for 15 minutes. If you did not ask for it, you can ignore this email.`,
    }),
    SUBMITTED: (w) => ({
      subject: `We received your company application ${w.reference}`,
      body: `Hello ${w.name},\n\nWe received the application for ${w.company} (reference ${w.reference}). A colleague will review it. We will email you if we need anything, and when there is a decision.\n\nFollow it here:\n${w.url}`,
    }),
    REVIEW_STARTED: (w) => ({
      subject: `Your company application ${w.reference} is being reviewed`,
      body: `Hello ${w.name},\n\nA reviewer has started checking the application for ${w.company}. There is nothing you need to do now.\n\n${w.url}`,
    }),
    INFO_REQUESTED: (w) => ({
      subject: `We need more information for ${w.reference}`,
      body: `Hello ${w.name},\n\nTo finish checking ${w.company}, our reviewer asks:\n\n${w.reason}\n\nReply and upload anything asked for here:\n${w.url}`,
    }),
    APPROVED: (w) => ({
      subject: `${w.company} is verified`,
      body: `Hello ${w.name},\n\n${w.company} is approved. You can now buy for the company: sign in and choose it on the Company tab.\n\n${w.url}`,
    }),
    REJECTED: (w) => ({
      subject: `Your company application ${w.reference} was not approved`,
      body: `Hello ${w.name},\n\nWe could not approve ${w.company}.\n\nReason: ${w.reason}\n\n${w.canResubmit ? `You can correct the application and send it again here:\n${w.url}` : 'If you think this is a mistake, reply to our support team.'}`,
    }),
    SUSPENDED: (w) => ({
      subject: `Buying for ${w.company} is paused`,
      body: `Hello ${w.name},\n\nBuying for ${w.company} has been paused.\n\nReason: ${w.reason}\n\nYour orders and invoices are still there. Contact our support team to resolve this.\n\n${w.url}`,
    }),
    REVERIFICATION: (w) => ({
      subject: `Please confirm the details of ${w.company} again`,
      body: `Hello ${w.name},\n\nWe need to check ${w.company} again before it can keep buying.\n\nWhat we need: ${w.reason}\n\nUpdate the application here:\n${w.url}`,
    }),
    RESTORED: (w) => ({
      subject: `${w.company} can buy again`,
      body: `Hello ${w.name},\n\nBuying for ${w.company} is open again.\n\n${w.reason}\n\n${w.url}`,
    }),
  },

  pl: {
    EMAIL_CODE: (w) => ({
      subject: `Twój kod dla ${w.company}: ${w.code}`,
      body: `Wpisz ten kod, aby potwierdzić ${w.email} jako firmowy adres e-mail ${w.company}:\n\n    ${w.code}\n\nKod jest ważny przez 15 minut. Jeśli nie prosiłeś o niego, zignoruj tę wiadomość.`,
    }),
    SUBMITTED: (w) => ({
      subject: `Otrzymaliśmy wniosek firmy ${w.reference}`,
      body: `Dzień dobry ${w.name},\n\nOtrzymaliśmy wniosek dla ${w.company} (numer ${w.reference}). Sprawdzi go nasz pracownik. Napiszemy, jeśli będziemy czegoś potrzebować, oraz gdy zapadnie decyzja.\n\nStatus wniosku:\n${w.url}`,
    }),
    REVIEW_STARTED: (w) => ({
      subject: `Wniosek firmy ${w.reference} jest sprawdzany`,
      body: `Dzień dobry ${w.name},\n\nNasz pracownik rozpoczął sprawdzanie wniosku dla ${w.company}. Na razie nie musisz nic robić.\n\n${w.url}`,
    }),
    INFO_REQUESTED: (w) => ({
      subject: `Potrzebujemy dodatkowych informacji do wniosku ${w.reference}`,
      body: `Dzień dobry ${w.name},\n\nAby dokończyć sprawdzanie ${w.company}, prosimy o:\n\n${w.reason}\n\nOdpowiedz i prześlij wymagane dokumenty tutaj:\n${w.url}`,
    }),
    APPROVED: (w) => ({
      subject: `Firma ${w.company} została zweryfikowana`,
      body: `Dzień dobry ${w.name},\n\nFirma ${w.company} została zatwierdzona. Możesz teraz kupować w jej imieniu: zaloguj się i wybierz ją w zakładce Firma.\n\n${w.url}`,
    }),
    REJECTED: (w) => ({
      subject: `Wniosek firmy ${w.reference} nie został zatwierdzony`,
      body: `Dzień dobry ${w.name},\n\nNie mogliśmy zatwierdzić firmy ${w.company}.\n\nPowód: ${w.reason}\n\n${w.canResubmit ? `Możesz poprawić wniosek i wysłać go ponownie tutaj:\n${w.url}` : 'Jeśli uważasz, że to pomyłka, odpisz naszemu zespołowi wsparcia.'}`,
    }),
    SUSPENDED: (w) => ({
      subject: `Zakupy dla ${w.company} są wstrzymane`,
      body: `Dzień dobry ${w.name},\n\nZakupy w imieniu ${w.company} zostały wstrzymane.\n\nPowód: ${w.reason}\n\nTwoje zamówienia i faktury pozostają dostępne. Skontaktuj się z naszym zespołem wsparcia.\n\n${w.url}`,
    }),
    REVERIFICATION: (w) => ({
      subject: `Prosimy ponownie potwierdzić dane firmy ${w.company}`,
      body: `Dzień dobry ${w.name},\n\nMusimy ponownie sprawdzić firmę ${w.company}, zanim będzie mogła dalej kupować.\n\nCzego potrzebujemy: ${w.reason}\n\nZaktualizuj wniosek tutaj:\n${w.url}`,
    }),
    RESTORED: (w) => ({
      subject: `${w.company} może znowu kupować`,
      body: `Dzień dobry ${w.name},\n\nZakupy w imieniu ${w.company} są ponownie możliwe.\n\n${w.reason}\n\n${w.url}`,
    }),
  },

  de: {
    EMAIL_CODE: (w) => ({
      subject: `Ihr Code für ${w.company}: ${w.code}`,
      body: `Geben Sie diesen Code ein, um ${w.email} als geschäftliche E-Mail-Adresse von ${w.company} zu bestätigen:\n\n    ${w.code}\n\nDer Code ist 15 Minuten gültig. Wenn Sie ihn nicht angefordert haben, ignorieren Sie diese E-Mail.`,
    }),
    SUBMITTED: (w) => ({
      subject: `Wir haben Ihren Firmenantrag ${w.reference} erhalten`,
      body: `Hallo ${w.name},\n\nwir haben den Antrag für ${w.company} (Referenz ${w.reference}) erhalten. Eine Kollegin oder ein Kollege prüft ihn. Wir melden uns, wenn wir etwas brauchen und sobald eine Entscheidung vorliegt.\n\nStatus des Antrags:\n${w.url}`,
    }),
    REVIEW_STARTED: (w) => ({
      subject: `Ihr Firmenantrag ${w.reference} wird geprüft`,
      body: `Hallo ${w.name},\n\ndie Prüfung des Antrags für ${w.company} hat begonnen. Sie müssen im Moment nichts tun.\n\n${w.url}`,
    }),
    INFO_REQUESTED: (w) => ({
      subject: `Wir benötigen weitere Angaben zu ${w.reference}`,
      body: `Hallo ${w.name},\n\num die Prüfung von ${w.company} abzuschließen, bitten wir um Folgendes:\n\n${w.reason}\n\nAntworten und laden Sie die angeforderten Unterlagen hier hoch:\n${w.url}`,
    }),
    APPROVED: (w) => ({
      subject: `${w.company} ist verifiziert`,
      body: `Hallo ${w.name},\n\n${w.company} ist freigegeben. Sie können jetzt für das Unternehmen einkaufen: Melden Sie sich an und wählen Sie es im Reiter Unternehmen.\n\n${w.url}`,
    }),
    REJECTED: (w) => ({
      subject: `Ihr Firmenantrag ${w.reference} wurde nicht genehmigt`,
      body: `Hallo ${w.name},\n\nwir konnten ${w.company} nicht freigeben.\n\nGrund: ${w.reason}\n\n${w.canResubmit ? `Sie können den Antrag korrigieren und hier erneut einreichen:\n${w.url}` : 'Wenn Sie dies für einen Fehler halten, antworten Sie unserem Support-Team.'}`,
    }),
    SUSPENDED: (w) => ({
      subject: `Einkäufe für ${w.company} sind ausgesetzt`,
      body: `Hallo ${w.name},\n\nEinkäufe für ${w.company} wurden ausgesetzt.\n\nGrund: ${w.reason}\n\nIhre Bestellungen und Rechnungen bleiben erhalten. Bitte wenden Sie sich an unser Support-Team.\n\n${w.url}`,
    }),
    REVERIFICATION: (w) => ({
      subject: `Bitte bestätigen Sie die Angaben zu ${w.company} erneut`,
      body: `Hallo ${w.name},\n\nwir müssen ${w.company} erneut prüfen, bevor weiter eingekauft werden kann.\n\nWas wir benötigen: ${w.reason}\n\nAktualisieren Sie den Antrag hier:\n${w.url}`,
    }),
    RESTORED: (w) => ({
      subject: `${w.company} kann wieder einkaufen`,
      body: `Hallo ${w.name},\n\nEinkäufe für ${w.company} sind wieder möglich.\n\n${w.reason}\n\n${w.url}`,
    }),
  },

  fr: {
    EMAIL_CODE: (w) => ({
      subject: `Votre code pour ${w.company} : ${w.code}`,
      body: `Saisissez ce code pour confirmer ${w.email} comme adresse e-mail professionnelle de ${w.company} :\n\n    ${w.code}\n\nIl est valable 15 minutes. Si vous ne l'avez pas demandé, ignorez cet e-mail.`,
    }),
    SUBMITTED: (w) => ({
      subject: `Nous avons reçu votre demande d'entreprise ${w.reference}`,
      body: `Bonjour ${w.name},\n\nNous avons reçu la demande pour ${w.company} (référence ${w.reference}). Un collègue va l'examiner. Nous vous écrirons si nous avons besoin de quoi que ce soit, et dès qu'une décision sera prise.\n\nSuivre la demande :\n${w.url}`,
    }),
    REVIEW_STARTED: (w) => ({
      subject: `Votre demande d'entreprise ${w.reference} est en cours d'examen`,
      body: `Bonjour ${w.name},\n\nL'examen de la demande pour ${w.company} a commencé. Vous n'avez rien à faire pour le moment.\n\n${w.url}`,
    }),
    INFO_REQUESTED: (w) => ({
      subject: `Nous avons besoin d'informations complémentaires pour ${w.reference}`,
      body: `Bonjour ${w.name},\n\nPour terminer la vérification de ${w.company}, nous vous demandons :\n\n${w.reason}\n\nRépondez et déposez les documents demandés ici :\n${w.url}`,
    }),
    APPROVED: (w) => ({
      subject: `${w.company} est vérifiée`,
      body: `Bonjour ${w.name},\n\n${w.company} est approuvée. Vous pouvez désormais acheter pour l'entreprise : connectez-vous et choisissez-la dans l'onglet Entreprise.\n\n${w.url}`,
    }),
    REJECTED: (w) => ({
      subject: `Votre demande d'entreprise ${w.reference} n'a pas été approuvée`,
      body: `Bonjour ${w.name},\n\nNous n'avons pas pu approuver ${w.company}.\n\nMotif : ${w.reason}\n\n${w.canResubmit ? `Vous pouvez corriger la demande et l'envoyer à nouveau ici :\n${w.url}` : "Si vous pensez qu'il s'agit d'une erreur, répondez à notre équipe d'assistance."}`,
    }),
    SUSPENDED: (w) => ({
      subject: `Les achats pour ${w.company} sont suspendus`,
      body: `Bonjour ${w.name},\n\nLes achats pour ${w.company} ont été suspendus.\n\nMotif : ${w.reason}\n\nVos commandes et factures restent disponibles. Contactez notre équipe d'assistance.\n\n${w.url}`,
    }),
    REVERIFICATION: (w) => ({
      subject: `Merci de confirmer à nouveau les informations de ${w.company}`,
      body: `Bonjour ${w.name},\n\nNous devons vérifier à nouveau ${w.company} avant qu'elle puisse continuer à acheter.\n\nCe dont nous avons besoin : ${w.reason}\n\nMettez la demande à jour ici :\n${w.url}`,
    }),
    RESTORED: (w) => ({
      subject: `${w.company} peut de nouveau acheter`,
      body: `Bonjour ${w.name},\n\nLes achats pour ${w.company} sont de nouveau possibles.\n\n${w.reason}\n\n${w.url}`,
    }),
  },

  es: {
    EMAIL_CODE: (w) => ({
      subject: `Su código para ${w.company}: ${w.code}`,
      body: `Introduzca este código para confirmar ${w.email} como correo de empresa de ${w.company}:\n\n    ${w.code}\n\nEs válido durante 15 minutos. Si no lo ha pedido, ignore este correo.`,
    }),
    SUBMITTED: (w) => ({
      subject: `Hemos recibido su solicitud de empresa ${w.reference}`,
      body: `Hola ${w.name}:\n\nHemos recibido la solicitud de ${w.company} (referencia ${w.reference}). Un compañero la revisará. Le escribiremos si necesitamos algo y cuando haya una decisión.\n\nSiga la solicitud aquí:\n${w.url}`,
    }),
    REVIEW_STARTED: (w) => ({
      subject: `Su solicitud de empresa ${w.reference} está en revisión`,
      body: `Hola ${w.name}:\n\nHemos empezado a revisar la solicitud de ${w.company}. Por ahora no tiene que hacer nada.\n\n${w.url}`,
    }),
    INFO_REQUESTED: (w) => ({
      subject: `Necesitamos más información para ${w.reference}`,
      body: `Hola ${w.name}:\n\nPara terminar de verificar ${w.company}, le pedimos:\n\n${w.reason}\n\nResponda y suba lo que se pide aquí:\n${w.url}`,
    }),
    APPROVED: (w) => ({
      subject: `${w.company} está verificada`,
      body: `Hola ${w.name}:\n\n${w.company} está aprobada. Ya puede comprar para la empresa: inicie sesión y elíjala en la pestaña Empresa.\n\n${w.url}`,
    }),
    REJECTED: (w) => ({
      subject: `Su solicitud de empresa ${w.reference} no se ha aprobado`,
      body: `Hola ${w.name}:\n\nNo hemos podido aprobar ${w.company}.\n\nMotivo: ${w.reason}\n\n${w.canResubmit ? `Puede corregir la solicitud y enviarla de nuevo aquí:\n${w.url}` : 'Si cree que es un error, responda a nuestro equipo de soporte.'}`,
    }),
    SUSPENDED: (w) => ({
      subject: `Las compras para ${w.company} están en pausa`,
      body: `Hola ${w.name}:\n\nLas compras para ${w.company} se han pausado.\n\nMotivo: ${w.reason}\n\nSus pedidos y facturas siguen disponibles. Póngase en contacto con nuestro equipo de soporte.\n\n${w.url}`,
    }),
    REVERIFICATION: (w) => ({
      subject: `Vuelva a confirmar los datos de ${w.company}`,
      body: `Hola ${w.name}:\n\nTenemos que volver a verificar ${w.company} antes de que pueda seguir comprando.\n\nLo que necesitamos: ${w.reason}\n\nActualice la solicitud aquí:\n${w.url}`,
    }),
    RESTORED: (w) => ({
      subject: `${w.company} ya puede volver a comprar`,
      body: `Hola ${w.name}:\n\nLas compras para ${w.company} vuelven a estar disponibles.\n\n${w.reason}\n\n${w.url}`,
    }),
  },

  it: {
    EMAIL_CODE: (w) => ({
      subject: `Il Suo codice per ${w.company}: ${w.code}`,
      body: `Inserisca questo codice per confermare ${w.email} come email aziendale di ${w.company}:\n\n    ${w.code}\n\nÈ valido per 15 minuti. Se non l'ha richiesto, ignori questa email.`,
    }),
    SUBMITTED: (w) => ({
      subject: `Abbiamo ricevuto la Sua richiesta aziendale ${w.reference}`,
      body: `Gentile ${w.name},\n\nabbiamo ricevuto la richiesta per ${w.company} (riferimento ${w.reference}). Un collega la esaminerà. Le scriveremo se ci serve qualcosa e quando ci sarà una decisione.\n\nSegua la richiesta qui:\n${w.url}`,
    }),
    REVIEW_STARTED: (w) => ({
      subject: `La Sua richiesta aziendale ${w.reference} è in revisione`,
      body: `Gentile ${w.name},\n\nabbiamo iniziato a verificare la richiesta per ${w.company}. Per ora non deve fare nulla.\n\n${w.url}`,
    }),
    INFO_REQUESTED: (w) => ({
      subject: `Ci servono altre informazioni per ${w.reference}`,
      body: `Gentile ${w.name},\n\nper completare la verifica di ${w.company}, Le chiediamo:\n\n${w.reason}\n\nRisponda e carichi quanto richiesto qui:\n${w.url}`,
    }),
    APPROVED: (w) => ({
      subject: `${w.company} è verificata`,
      body: `Gentile ${w.name},\n\n${w.company} è approvata. Ora può acquistare per l'azienda: acceda e la scelga nella scheda Azienda.\n\n${w.url}`,
    }),
    REJECTED: (w) => ({
      subject: `La Sua richiesta aziendale ${w.reference} non è stata approvata`,
      body: `Gentile ${w.name},\n\nnon abbiamo potuto approvare ${w.company}.\n\nMotivo: ${w.reason}\n\n${w.canResubmit ? `Può correggere la richiesta e inviarla di nuovo qui:\n${w.url}` : 'Se ritiene che sia un errore, risponda al nostro team di assistenza.'}`,
    }),
    SUSPENDED: (w) => ({
      subject: `Gli acquisti per ${w.company} sono sospesi`,
      body: `Gentile ${w.name},\n\ngli acquisti per ${w.company} sono stati sospesi.\n\nMotivo: ${w.reason}\n\nOrdini e fatture restano disponibili. Contatti il nostro team di assistenza.\n\n${w.url}`,
    }),
    REVERIFICATION: (w) => ({
      subject: `Confermi di nuovo i dati di ${w.company}`,
      body: `Gentile ${w.name},\n\ndobbiamo verificare di nuovo ${w.company} prima che possa continuare ad acquistare.\n\nCosa ci serve: ${w.reason}\n\nAggiorni la richiesta qui:\n${w.url}`,
    }),
    RESTORED: (w) => ({
      subject: `${w.company} può di nuovo acquistare`,
      body: `Gentile ${w.name},\n\ngli acquisti per ${w.company} sono di nuovo possibili.\n\n${w.reason}\n\n${w.url}`,
    }),
  },

  nl: {
    EMAIL_CODE: (w) => ({
      subject: `Uw code voor ${w.company}: ${w.code}`,
      body: `Voer deze code in om ${w.email} te bevestigen als zakelijk e-mailadres van ${w.company}:\n\n    ${w.code}\n\nDe code is 15 minuten geldig. Hebt u hier niet om gevraagd, dan kunt u deze e-mail negeren.`,
    }),
    SUBMITTED: (w) => ({
      subject: `We hebben uw bedrijfsaanvraag ${w.reference} ontvangen`,
      body: `Hallo ${w.name},\n\nWe hebben de aanvraag voor ${w.company} (referentie ${w.reference}) ontvangen. Een collega beoordeelt deze. We mailen u als we iets nodig hebben en zodra er een besluit is.\n\nVolg de aanvraag hier:\n${w.url}`,
    }),
    REVIEW_STARTED: (w) => ({
      subject: `Uw bedrijfsaanvraag ${w.reference} wordt beoordeeld`,
      body: `Hallo ${w.name},\n\nDe beoordeling van de aanvraag voor ${w.company} is begonnen. U hoeft nu niets te doen.\n\n${w.url}`,
    }),
    INFO_REQUESTED: (w) => ({
      subject: `We hebben meer informatie nodig voor ${w.reference}`,
      body: `Hallo ${w.name},\n\nOm de controle van ${w.company} af te ronden, vragen we:\n\n${w.reason}\n\nAntwoord en upload wat gevraagd wordt hier:\n${w.url}`,
    }),
    APPROVED: (w) => ({
      subject: `${w.company} is geverifieerd`,
      body: `Hallo ${w.name},\n\n${w.company} is goedgekeurd. U kunt nu voor het bedrijf inkopen: meld u aan en kies het op het tabblad Bedrijf.\n\n${w.url}`,
    }),
    REJECTED: (w) => ({
      subject: `Uw bedrijfsaanvraag ${w.reference} is niet goedgekeurd`,
      body: `Hallo ${w.name},\n\nWe konden ${w.company} niet goedkeuren.\n\nReden: ${w.reason}\n\n${w.canResubmit ? `U kunt de aanvraag corrigeren en hier opnieuw indienen:\n${w.url}` : 'Denkt u dat dit een vergissing is, antwoord dan aan ons supportteam.'}`,
    }),
    SUSPENDED: (w) => ({
      subject: `Inkopen voor ${w.company} is gepauzeerd`,
      body: `Hallo ${w.name},\n\nInkopen voor ${w.company} is gepauzeerd.\n\nReden: ${w.reason}\n\nUw bestellingen en facturen blijven beschikbaar. Neem contact op met ons supportteam.\n\n${w.url}`,
    }),
    REVERIFICATION: (w) => ({
      subject: `Bevestig de gegevens van ${w.company} opnieuw`,
      body: `Hallo ${w.name},\n\nWe moeten ${w.company} opnieuw controleren voordat er verder kan worden ingekocht.\n\nWat we nodig hebben: ${w.reason}\n\nWerk de aanvraag hier bij:\n${w.url}`,
    }),
    RESTORED: (w) => ({
      subject: `${w.company} kan weer inkopen`,
      body: `Hallo ${w.name},\n\nInkopen voor ${w.company} is weer mogelijk.\n\n${w.reason}\n\n${w.url}`,
    }),
  },

  el: {
    EMAIL_CODE: (w) => ({
      subject: `Ο κωδικός σας για ${w.company}: ${w.code}`,
      body: `Πληκτρολογήστε αυτόν τον κωδικό για να επιβεβαιώσετε το ${w.email} ως επαγγελματικό email της ${w.company}:\n\n    ${w.code}\n\nΙσχύει για 15 λεπτά. Αν δεν τον ζητήσατε, αγνοήστε αυτό το μήνυμα.`,
    }),
    SUBMITTED: (w) => ({
      subject: `Λάβαμε την αίτηση εταιρείας ${w.reference}`,
      body: `Γεια σας ${w.name},\n\nΛάβαμε την αίτηση για την ${w.company} (αριθμός αναφοράς ${w.reference}). Ένας συνάδελφος θα την ελέγξει. Θα σας γράψουμε αν χρειαστούμε κάτι και όταν υπάρξει απόφαση.\n\nΠαρακολουθήστε την αίτηση εδώ:\n${w.url}`,
    }),
    REVIEW_STARTED: (w) => ({
      subject: `Η αίτηση εταιρείας ${w.reference} ελέγχεται`,
      body: `Γεια σας ${w.name},\n\nΞεκίνησε ο έλεγχος της αίτησης για την ${w.company}. Δεν χρειάζεται να κάνετε τίποτα αυτή τη στιγμή.\n\n${w.url}`,
    }),
    INFO_REQUESTED: (w) => ({
      subject: `Χρειαζόμαστε περισσότερες πληροφορίες για την ${w.reference}`,
      body: `Γεια σας ${w.name},\n\nΓια να ολοκληρώσουμε τον έλεγχο της ${w.company}, σας ζητάμε:\n\n${w.reason}\n\nΑπαντήστε και ανεβάστε ό,τι ζητείται εδώ:\n${w.url}`,
    }),
    APPROVED: (w) => ({
      subject: `Η ${w.company} επαληθεύτηκε`,
      body: `Γεια σας ${w.name},\n\nΗ ${w.company} εγκρίθηκε. Μπορείτε πλέον να αγοράζετε για την εταιρεία: συνδεθείτε και επιλέξτε την στην καρτέλα Εταιρεία.\n\n${w.url}`,
    }),
    REJECTED: (w) => ({
      subject: `Η αίτηση εταιρείας ${w.reference} δεν εγκρίθηκε`,
      body: `Γεια σας ${w.name},\n\nΔεν μπορέσαμε να εγκρίνουμε την ${w.company}.\n\nΛόγος: ${w.reason}\n\n${w.canResubmit ? `Μπορείτε να διορθώσετε την αίτηση και να την υποβάλετε ξανά εδώ:\n${w.url}` : 'Αν πιστεύετε ότι πρόκειται για λάθος, απαντήστε στην ομάδα υποστήριξης.'}`,
    }),
    SUSPENDED: (w) => ({
      subject: `Οι αγορές για την ${w.company} έχουν ανασταλεί`,
      body: `Γεια σας ${w.name},\n\nΟι αγορές για την ${w.company} ανεστάλησαν.\n\nΛόγος: ${w.reason}\n\nΟι παραγγελίες και τα τιμολόγιά σας παραμένουν διαθέσιμα. Επικοινωνήστε με την ομάδα υποστήριξης.\n\n${w.url}`,
    }),
    REVERIFICATION: (w) => ({
      subject: `Επιβεβαιώστε ξανά τα στοιχεία της ${w.company}`,
      body: `Γεια σας ${w.name},\n\nΠρέπει να ελέγξουμε ξανά την ${w.company} πριν συνεχίσει τις αγορές.\n\nΤι χρειαζόμαστε: ${w.reason}\n\nΕνημερώστε την αίτηση εδώ:\n${w.url}`,
    }),
    RESTORED: (w) => ({
      subject: `Η ${w.company} μπορεί ξανά να αγοράζει`,
      body: `Γεια σας ${w.name},\n\nΟι αγορές για την ${w.company} είναι ξανά διαθέσιμες.\n\n${w.reason}\n\n${w.url}`,
    }),
  },
};

function languageOf(value: string | null): Language {
  return value !== null && value in MESSAGES ? (value as Language) : 'en';
}

/** Where a company's own application page lives on the storefront. */
export function companyApplicationUrl(companyId: string): string {
  return `${env.CUSTOMER_WEB_PUBLIC_URL.replace(/\/$/, '')}/account/companies/${companyId}`;
}

export interface CompanyEmailInput {
  kind: CompanyEmailKind;
  companyId: string;
  /** Who it goes to. Defaults to every active OWNER and COMPANY_ADMIN. */
  recipientUserId?: string;
  /** Overrides the recipient's own address - only the email code does this. */
  recipientEmail?: string;
  code?: string;
  reason?: string | null;
  canResubmit?: boolean;
  dedupeKey?: string;
  correlationId?: string | null;
  tx?: unknown;
}

/**
 * Word one email per recipient, in their language, and put it in the outbox.
 * Inside `tx` when given, so a rolled-back decision sends nothing.
 */
export async function sendCompanyEmail(input: CompanyEmailInput): Promise<void> {
  const client = (input.tx ?? prisma) as typeof prisma;

  const company = await client.buyerCompany.findUnique({
    where: { id: input.companyId },
    select: {
      legalName: true,
      tradingName: true,
      applicationReference: true,
      businessEmail: true,
      members: {
        where:
          input.recipientUserId !== undefined
            ? { userId: input.recipientUserId, status: 'ACTIVE' }
            : { status: 'ACTIVE', role: { in: ['OWNER', 'COMPANY_ADMIN'] } },
        select: {
          user: {
            select: {
              id: true,
              email: true,
              preferredLanguage: true,
              customerProfile: { select: { fullName: true } },
            },
          },
        },
      },
    },
  });

  if (company === null) return;

  const companyName = company.tradingName ?? company.legalName ?? company.applicationReference;

  for (const { user } of company.members) {
    const language = languageOf(user.preferredLanguage);
    const words: Words = {
      name: user.customerProfile?.fullName ?? '',
      company: companyName,
      reference: company.applicationReference,
      url: companyApplicationUrl(input.companyId),
      code: input.code ?? '',
      email: input.recipientEmail ?? company.businessEmail ?? '',
      reason: input.reason ?? '',
      canResubmit: input.canResubmit ?? false,
    };
    const message = MESSAGES[language][input.kind](words);

    await enqueueNotification(
      {
        eventKey: EVENT[input.kind],
        recipientEmail: input.recipientEmail ?? user.email,
        recipientName: words.name,
        variables: { subjectLine: message.subject, bodyText: message.body },
        ...(input.dedupeKey !== undefined ? { dedupeKey: `${input.dedupeKey}:${user.id}` } : {}),
        relatedType: 'buyer_company',
        relatedId: input.companyId,
        correlationId: input.correlationId ?? null,
      },
      input.tx,
    );
  }
}

/** The languages this file is written in. For the test that keeps them in step. */
export const COMPANY_EMAIL_LANGUAGES = Object.keys(MESSAGES) as Language[];
export const COMPANY_EMAIL_KINDS = Object.keys(EVENT) as CompanyEmailKind[];
export function renderCompanyEmail(
  language: string,
  kind: CompanyEmailKind,
  words: Words,
): { subject: string; body: string } {
  return MESSAGES[languageOf(language)][kind](words);
}
