/**
 * The email asking somebody to join a buyer company (Master rows 11 and 14).
 *
 * Worded in the INVITER's language. The person invited may have no account
 * here yet, so there is no language of theirs to use; a colleague at the same
 * company is the best guess there is. The role names are the storefront's
 * own (`companyRole.*`), so the email and the screen say the same thing.
 *
 * What it may contain: the company's name, who asked, the role, the link and
 * the date it stops working. Never a registration or tax number.
 */
import type { BuyerCompanyRoleName } from '../../domain/buyer-company-state.js';

export type InvitationLanguage = 'en' | 'pl' | 'de' | 'fr' | 'es' | 'it' | 'nl' | 'el';

interface Words {
  company: string;
  inviter: string;
  role: BuyerCompanyRoleName;
  url: string;
  expires: string;
}

const ROLE: Record<InvitationLanguage, Record<BuyerCompanyRoleName, string>> = {
  en: { OWNER: 'Owner', COMPANY_ADMIN: 'Company admin', BUYER: 'Buyer', ORDER_APPROVER: 'Order approver', FINANCE: 'Finance', VIEWER: 'Viewer' },
  de: { OWNER: 'Inhaber', COMPANY_ADMIN: 'Unternehmensadmin', BUYER: 'Einkäufer', ORDER_APPROVER: 'Bestellfreigabe', FINANCE: 'Finanzen', VIEWER: 'Nur Ansicht' },
  el: { OWNER: 'Ιδιοκτήτης', COMPANY_ADMIN: 'Διαχειριστής εταιρείας', BUYER: 'Αγοραστής', ORDER_APPROVER: 'Εγκρίνων παραγγελίες', FINANCE: 'Οικονομικά', VIEWER: 'Μόνο προβολή' },
  es: { OWNER: 'Propietario', COMPANY_ADMIN: 'Administrador de la empresa', BUYER: 'Comprador', ORDER_APPROVER: 'Aprobador de pedidos', FINANCE: 'Finanzas', VIEWER: 'Solo lectura' },
  fr: { OWNER: 'Propriétaire', COMPANY_ADMIN: "Administrateur de l'entreprise", BUYER: 'Acheteur', ORDER_APPROVER: 'Approbateur des commandes', FINANCE: 'Finance', VIEWER: 'Lecture seule' },
  it: { OWNER: 'Titolare', COMPANY_ADMIN: 'Amministratore aziendale', BUYER: 'Acquirente', ORDER_APPROVER: 'Approvatore ordini', FINANCE: 'Finanza', VIEWER: 'Sola lettura' },
  nl: { OWNER: 'Eigenaar', COMPANY_ADMIN: 'Bedrijfsbeheerder', BUYER: 'Inkoper', ORDER_APPROVER: 'Goedkeurder van bestellingen', FINANCE: 'Financiën', VIEWER: 'Alleen lezen' },
  pl: { OWNER: 'Właściciel', COMPANY_ADMIN: 'Administrator firmy', BUYER: 'Kupujący', ORDER_APPROVER: 'Zatwierdzający zamówienia', FINANCE: 'Finanse', VIEWER: 'Podgląd' },
};

type Message = (w: Words, role: string) => { subject: string; body: string };

const MESSAGES: Record<InvitationLanguage, Message> = {
  en: (w, role) => ({
    subject: `Join ${w.company} as ${role}`,
    body: `Hello,\n\n${w.inviter} has invited you to buy for ${w.company} as ${role}.\n\nTo accept, open the link below and sign in with this email address, or create an account with it:\n${w.url}\n\nThe link stops working on ${w.expires}. If you were not expecting this, ignore it: nothing happens until somebody accepts.`,
  }),
  de: (w, role) => ({
    subject: `Treten Sie ${w.company} als ${role} bei`,
    body: `Guten Tag,\n\n${w.inviter} hat Sie eingeladen, als ${role} für ${w.company} einzukaufen.\n\nÖffnen Sie zum Annehmen den folgenden Link und melden Sie sich mit dieser E-Mail-Adresse an, oder erstellen Sie damit ein Konto:\n${w.url}\n\nDer Link funktioniert bis ${w.expires}. Wenn Sie diese Einladung nicht erwartet haben, ignorieren Sie sie: Es geschieht nichts, solange sie niemand annimmt.`,
  }),
  el: (w, role) => ({
    subject: `Γίνετε μέλος της ${w.company} ως ${role}`,
    body: `Γεια σας,\n\nΟ/Η ${w.inviter} σας προσκάλεσε να αγοράζετε για την ${w.company} ως ${role}.\n\nΓια να αποδεχτείτε, ανοίξτε τον παρακάτω σύνδεσμο και συνδεθείτε με αυτή τη διεύθυνση email ή δημιουργήστε λογαριασμό με αυτήν:\n${w.url}\n\nΟ σύνδεσμος παύει να ισχύει στις ${w.expires}. Αν δεν περιμένατε αυτό το μήνυμα, αγνοήστε το: τίποτα δεν συμβαίνει μέχρι να το αποδεχτεί κάποιος.`,
  }),
  es: (w, role) => ({
    subject: `Únase a ${w.company} como ${role}`,
    body: `Hola:\n\n${w.inviter} le ha invitado a comprar para ${w.company} como ${role}.\n\nPara aceptar, abra el enlace siguiente e inicie sesión con esta dirección de correo, o cree una cuenta con ella:\n${w.url}\n\nEl enlace deja de funcionar el ${w.expires}. Si no esperaba esta invitación, ignórela: no ocurre nada hasta que alguien la acepte.`,
  }),
  fr: (w, role) => ({
    subject: `Rejoignez ${w.company} en tant que ${role}`,
    body: `Bonjour,\n\n${w.inviter} vous invite à acheter pour ${w.company} en tant que ${role}.\n\nPour accepter, ouvrez le lien ci-dessous et connectez-vous avec cette adresse e-mail, ou créez un compte avec elle :\n${w.url}\n\nLe lien cesse de fonctionner le ${w.expires}. Si vous n'attendiez pas cette invitation, ignorez-la : rien ne se passe tant que personne ne l'accepte.`,
  }),
  it: (w, role) => ({
    subject: `Entri in ${w.company} come ${role}`,
    body: `Buongiorno,\n\n${w.inviter} la invita ad acquistare per ${w.company} come ${role}.\n\nPer accettare, apra il link qui sotto e acceda con questo indirizzo email, oppure crei un account con esso:\n${w.url}\n\nIl link smette di funzionare il ${w.expires}. Se non si aspettava questo invito, lo ignori: non succede nulla finché qualcuno non lo accetta.`,
  }),
  nl: (w, role) => ({
    subject: `Sluit u aan bij ${w.company} als ${role}`,
    body: `Hallo,\n\n${w.inviter} heeft u uitgenodigd om voor ${w.company} in te kopen als ${role}.\n\nOpen de onderstaande link om te accepteren en meld u aan met dit e-mailadres, of maak er een account mee aan:\n${w.url}\n\nDe link werkt tot ${w.expires}. Had u deze uitnodiging niet verwacht, negeer haar dan: er gebeurt niets zolang niemand haar accepteert.`,
  }),
  pl: (w, role) => ({
    subject: `Dołącz do ${w.company} jako ${role}`,
    body: `Dzień dobry,\n\n${w.inviter} zaprasza Cię do kupowania dla ${w.company} w roli: ${role}.\n\nAby przyjąć zaproszenie, otwórz poniższy link i zaloguj się tym adresem e-mail albo załóż z nim konto:\n${w.url}\n\nLink przestaje działać ${w.expires}. Jeśli nie spodziewałeś się tego zaproszenia, zignoruj je: nic się nie stanie, dopóki ktoś go nie przyjmie.`,
  }),
};

export const INVITATION_LANGUAGES = Object.keys(MESSAGES) as InvitationLanguage[];

export function invitationLanguageOf(value: string | null | undefined): InvitationLanguage {
  return value !== null && value !== undefined && value in MESSAGES ? (value as InvitationLanguage) : 'en';
}

export function renderInvitationEmail(language: string | null | undefined, words: Words): { subject: string; body: string } {
  const lang = invitationLanguageOf(language);
  return MESSAGES[lang](words, ROLE[lang][words.role]);
}
