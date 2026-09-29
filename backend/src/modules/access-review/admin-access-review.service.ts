/**
 * The access-review facts for staff, read-only (checklist Master row 14).
 *
 * The same facts the seller's or company's own owner sees - each member's
 * role, when they joined, who invited them, when they last signed in and were
 * active, the open invitations and the recent reviews - so an operator
 * answering "who can act for this business?" reads the same answer the
 * business does. Staff change nothing here: membership belongs to the
 * business, and the console's existing seller and company decisions are the
 * operator's lever.
 */
import { notFound } from '../../domain/errors.js';
import { prisma } from '../../infra/prisma.js';
import {
  accessReviewSummary,
  activityForUsers,
  hubActivityForSeller,
  namesForProfiles,
  namesForUsers,
  type AccessReviewSummary,
} from './access-review.service.js';

export interface AdminAccessMember {
  id: string;
  name: string;
  email: string;
  role: string;
  joinedAt: string;
  invitedByName: string | null;
  lastSignInAt: string | null;
  lastActiveAt: string | null;
  /** Sellers only: last deliberate use of this seller's Hub. */
  lastHubActivityAt: string | null;
}

export interface AdminAccessInvitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  expired: boolean;
  sendCount: number;
  invitedByName: string | null;
}

export interface AdminAccessView {
  members: AdminAccessMember[];
  invitations: AdminAccessInvitation[];
  accessReview: AccessReviewSummary;
}

export async function sellerAccessForStaff(sellerAccountId: string): Promise<AdminAccessView> {
  const seller = await prisma.sellerAccount.findUnique({ where: { id: sellerAccountId }, select: { id: true } });
  if (seller === null) throw notFound('Seller');

  const [members, invitations] = await Promise.all([
    prisma.sellerMember.findMany({
      where: { sellerAccountId, removedAt: null },
      orderBy: { joinedAt: 'asc' },
      select: {
        id: true,
        role: true,
        joinedAt: true,
        invitedByProfileId: true,
        customerProfile: { select: { fullName: true, userId: true, user: { select: { email: true } } } },
      },
    }),
    prisma.sellerInvitation.findMany({
      where: { sellerAccountId, liveKey: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
  ]);
  const userIds = members.map((member) => member.customerProfile.userId);
  const [activity, hub, inviters, accessReview] = await Promise.all([
    activityForUsers(userIds),
    hubActivityForSeller(sellerAccountId, userIds),
    namesForProfiles([...members.map((member) => member.invitedByProfileId), ...invitations.map((row) => row.invitedByProfileId)]),
    accessReviewSummary({ sellerAccountId }),
  ]);
  const now = Date.now();

  return {
    members: members.map((member) => ({
      id: member.id,
      name: member.customerProfile.fullName ?? '',
      email: member.customerProfile.user.email,
      role: member.role,
      joinedAt: member.joinedAt.toISOString(),
      invitedByName: member.invitedByProfileId === null ? null : (inviters.get(member.invitedByProfileId) ?? null),
      lastSignInAt: activity.get(member.customerProfile.userId)?.lastSignInAt ?? null,
      lastActiveAt: activity.get(member.customerProfile.userId)?.lastActiveAt ?? null,
      lastHubActivityAt: hub.get(member.customerProfile.userId) ?? null,
    })),
    invitations: invitations.map((invitation) => ({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt.toISOString(),
      expired: invitation.expiresAt.getTime() <= now,
      sendCount: invitation.sendCount,
      invitedByName: invitation.invitedByProfileId === null ? null : (inviters.get(invitation.invitedByProfileId) ?? null),
    })),
    accessReview,
  };
}

export async function companyAccessForStaff(companyId: string): Promise<AdminAccessView> {
  const company = await prisma.buyerCompany.findUnique({ where: { id: companyId }, select: { id: true } });
  if (company === null) throw notFound('Company');

  const [members, invitations] = await Promise.all([
    prisma.buyerCompanyMember.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        userId: true,
        role: true,
        createdAt: true,
        invitedByUserId: true,
        user: { select: { email: true, customerProfile: { select: { fullName: true } } } },
      },
    }),
    prisma.buyerCompanyInvitation.findMany({
      where: { companyId, liveKey: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
  ]);
  const [activity, inviters, accessReview] = await Promise.all([
    activityForUsers(members.map((member) => member.userId)),
    namesForUsers([...members.map((member) => member.invitedByUserId), ...invitations.map((row) => row.invitedByUserId)]),
    accessReviewSummary({ buyerCompanyId: companyId }),
  ]);
  const now = Date.now();

  return {
    members: members.map((member) => ({
      id: member.id,
      name: member.user.customerProfile?.fullName ?? '',
      email: member.user.email,
      role: member.role,
      joinedAt: member.createdAt.toISOString(),
      invitedByName: member.invitedByUserId === null ? null : (inviters.get(member.invitedByUserId) ?? null),
      lastSignInAt: activity.get(member.userId)?.lastSignInAt ?? null,
      lastActiveAt: activity.get(member.userId)?.lastActiveAt ?? null,
      lastHubActivityAt: null,
    })),
    invitations: invitations.map((invitation) => ({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt.toISOString(),
      expired: invitation.expiresAt.getTime() <= now,
      sendCount: invitation.sendCount,
      invitedByName: inviters.get(invitation.invitedByUserId) ?? null,
    })),
    accessReview,
  };
}
