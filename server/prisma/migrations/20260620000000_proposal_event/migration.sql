-- Add the PROPOSAL_DISCUSSION_REQUESTED partner event type (customer "request a
-- quote/call/meeting" lands in the Fleet inbox). Additive enum value.
ALTER TYPE "PartnerEventType" ADD VALUE IF NOT EXISTS 'PROPOSAL_DISCUSSION_REQUESTED';