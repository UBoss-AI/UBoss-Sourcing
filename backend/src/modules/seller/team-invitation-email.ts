/**
 * The email asking somebody to join a seller's team (checklist Master row 14).
 *
 * Worded in the INVITER's language, for the same reason as the buyer-company
 * invitation: the person invited may have no account here yet, so there is no
 * language of theirs to use, and a colleague is the best guess there is. The
 * role names match the Seller Hub's own (`sellerRole.*`), so the email and the
 * screen say the same thing.
 *
 * What it may contain: the seller's public name, who asked, the role, the link
 * and the date it stops working. Nothing else about the business.
 */
import type { SellerRoleKey } from '../../domain/seller-permissions.js';
import { invitationLanguageOf, type InvitationLanguage } from '../buyer-companies/invitation-email.js';

interface Words {
  seller: string;
  inviter: string;
  role: SellerRoleKey;
  url: string;
  expires: string;
}

const ROLE: Record<InvitationLanguage, Record<SellerRoleKey, string>> = {
  en: {
    OWNER: 'Owner',
    ADMIN: 'Admin',
    CATALOGUE_MANAGER: 'Catalogue manager',
    INVENTORY_MANAGER: 'Inventory manager',
    ORDER_MANAGER: 'Order manager',
    FINANCE_VIEWER: 'Finance viewer',
    SUPPORT_MEMBER: 'Support',
  },
  de: {
    OWNER: 'Inhaber',
    ADMIN: 'Administrator',
    CATALOGUE_MANAGER: 'Katalogverwaltung',
    INVENTORY_MANAGER: 'Lagerverwaltung',
    ORDER_MANAGER: 'Auftragsverwaltung',
    FINANCE_VIEWER: 'Finanzen (nur Ansicht)',
    SUPPORT_MEMBER: 'Kundenservice',
  },
  el: {
    OWNER: 'Ιδιοκτήτης',
    ADMIN: 'Διαχειριστής',
    CATALOGUE_MANAGER: 'Υπεύθυνος καταλόγου',
    INVENTORY_MANAGER: 'Υπεύθυνος αποθέματος',
    ORDER_MANAGER: 'Υπεύθυνος παραγγελιών',
    FINANCE_VIEWER: 'Οικονομικά (μόνο προβολή)',
    SUPPORT_MEMBER: 'Εξυπηρέτηση',
  },
  es: {
    OWNER: 'Propietario',
    ADMIN: 'Administrador',
    CATALOGUE_MANAGER: 'Gestor de catálogo',
    INVENTORY_MANAGER: 'Gestor de inventario',
    ORDER_MANAGER: 'Gestor de pedidos',
    FINANCE_VIEWER: 'Finanzas (solo lectura)',
    SUPPORT_MEMBER: 'Atención al cliente',
  },
  fr: {
    OWNER: 'Propriétaire',
    ADMIN: 'Administrateur',
    CATALOGUE_MANAGER: 'Responsable du catalogue',
    INVENTORY_MANAGER: 'Responsable des stocks',
    ORDER_MANAGER: 'Responsable des commandes',
    FINANCE_VIEWER: 'Finance (lecture seule)',
    SUPPORT_MEMBER: 'Service client',
  },
  it: {
    OWNER: 'Titolare',
    ADMIN: 'Amministratore',
    CATALOGUE_MANAGER: 'Responsabile catalogo',
    INVENTORY_MANAGER: 'Responsabile magazzino',
    ORDER_MANAGER: 'Responsabile ordini',
    FINANCE_VIEWER: 'Finanza (sola lettura)',
    SUPPORT_MEMBER: 'Assistenza clienti',
  },
  nl: {
    OWNER: 'Eigenaar',
    ADMIN: 'Beheerder',
    CATALOGUE_MANAGER: 'Catalogusbeheerder',
    INVENTORY_MANAGER: 'Voorraadbeheerder',
    ORDER_MANAGER: 'Orderbeheerder',
    FINANCE_VIEWER: 'Financiën (alleen lezen)',
    SUPPORT_MEMBER: 'Klantenservice',
  },
  pl: {
    OWNER: 'Właściciel',
    ADMIN: 'Administrator',
    CATALOGUE_MANAGER: 'Menedżer katalogu',
    INVENTORY_MANAGER: 'Menedżer magazynu',
    ORDER_MANAGER: 'Menedżer zamówień',
    FINANCE_VIEWER: 'Finanse (tylko podgląd)',
    SUPPORT_MEMBER: 'Obsługa klienta',
  },
};

type Message = (w: Words, role: string) => { subject: string; body: string };

const MESSAGES: Record<InvitationLanguage, Message> = {
  en: (w, role) => ({
    subject: `Join the ${w.seller} team as ${role}`,
    body: `Hello,\n\n${w.inviter} has invited you to help run ${w.seller} in the Seller Hub, in the role: ${role}.\n\nTo accept, open the link below and sign in with this email address, or create an account with it:\n${w.url}\n\nThe link stops working on ${w.expires}. If you were not expecting this, ignore it: nothing happens until somebody accepts.`,
  }),
  de: (w, role) => ({
    subject: `Werden Sie Teil des Teams von ${w.seller} (${role})`,
    body: `Guten Tag,\n\n${w.inviter} hat Sie eingeladen, ${w.seller} im Seller Hub mitzubetreuen, in der Rolle: ${role}.\n\nÖffnen Sie zum Annehmen den folgenden Link und melden Sie sich mit dieser E-Mail-Adresse an, oder erstellen Sie damit ein Konto:\n${w.url}\n\nDer Link funktioniert bis ${w.expires}. Wenn Sie diese Einladung nicht erwartet haben, ignorieren Sie sie: Es geschieht nichts, solange sie niemand annimmt.`,
  }),
  el: (w, role) => ({
    subject: `Γίνετε μέλος της ομάδας του ${w.seller} (${role})`,
    body: `Γεια σας,\n\nΟ/Η ${w.inviter} σας προσκάλεσε να βοηθάτε στη διαχείριση του ${w.seller} στο Seller Hub, με ρόλο: ${role}.\n\nΓια να αποδεχτείτε, ανοίξτε τον παρακάτω σύνδεσμο και συνδεθείτε με αυτή τη διεύθυνση email ή δημιουργήστε λογαριασμό με αυτήν:\n${w.url}\n\nΟ σύνδεσμος παύει να λειτουργεί στις ${w.expires}. Αν δεν περιμένατε αυτή την πρόσκληση, αγνοήστε τη: τίποτα δεν συμβαίνει μέχρι να την αποδεχτεί κάποιος.`,
  }),
  es: (w, role) => ({
    subject: `Únase al equipo de ${w.seller} (${role})`,
    body: `Hola:\n\n${w.inviter} le ha invitado a ayudar a gestionar ${w.seller} en el Seller Hub, con el rol: ${role}.\n\nPara aceptar, abra el enlace siguiente e inicie sesión con esta dirección de correo, o cree una cuenta con ella:\n${w.url}\n\nEl enlace deja de funcionar el ${w.expires}. Si no esperaba esta invitación, ignórela: no ocurre nada hasta que alguien la acepte.`,
  }),
  fr: (w, role) => ({
    subject: `Rejoignez l'équipe de ${w.seller} (${role})`,
    body: `Bonjour,\n\n${w.inviter} vous invite à participer à la gestion de ${w.seller} dans le Seller Hub, avec le rôle : ${role}.\n\nPour accepter, ouvrez le lien ci-dessous et connectez-vous avec cette adresse e-mail, ou créez un compte avec elle :\n${w.url}\n\nLe lien cesse de fonctionner le ${w.expires}. Si vous n'attendiez pas cette invitation, ignorez-la : rien ne se passe tant que personne ne l'accepte.`,
  }),
  it: (w, role) => ({
    subject: `Entri nel team di ${w.seller} (${role})`,
    body: `Buongiorno,\n\n${w.inviter} la invita ad aiutare a gestire ${w.seller} nel Seller Hub, con il ruolo: ${role}.\n\nPer accettare, apra il link qui sotto e acceda con questo indirizzo email, oppure crei un account con esso:\n${w.url}\n\nIl link smette di funzionare il ${w.expires}. Se non si aspettava questo invito, lo ignori: non succede nulla finché qualcuno non lo accetta.`,
  }),
  nl: (w, role) => ({
    subject: `Word lid van het team van ${w.seller} (${role})`,
    body: `Hallo,\n\n${w.inviter} heeft u uitgenodigd om ${w.seller} mee te beheren in de Seller Hub, in de rol: ${role}.\n\nOpen de onderstaande link om te accepteren en meld u aan met dit e-mailadres, of maak er een account mee aan:\n${w.url}\n\nDe link werkt tot ${w.expires}. Had u deze uitnodiging niet verwacht, negeer haar dan: er gebeurt niets zolang niemand haar accepteert.`,
  }),
  pl: (w, role) => ({
    subject: `Dołącz do zespołu ${w.seller} (${role})`,
    body: `Dzień dobry,\n\n${w.inviter} zaprasza Cię do współprowadzenia ${w.seller} w Seller Hub, w roli: ${role}.\n\nAby przyjąć zaproszenie, otwórz poniższy link i zaloguj się tym adresem e-mail albo załóż z nim konto:\n${w.url}\n\nLink przestaje działać ${w.expires}. Jeśli nie spodziewałeś się tego zaproszenia, zignoruj je: nic się nie stanie, dopóki ktoś go nie przyjmie.`,
  }),
};

export function renderSellerInvitationEmail(language: string | null | undefined, words: Words): { subject: string; body: string } {
  const lang = invitationLanguageOf(language);
  return MESSAGES[lang](words, ROLE[lang][words.role]);
}
