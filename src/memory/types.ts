import type { Jd, Scorecard } from '../types.ts';
import type { RatingThresholds } from '../tools/scorecard.ts';

export interface PolicyProfile { jd: Jd; scorecard: Scorecard; thresholds?: RatingThresholds }
export interface JobFamily { id: string; name: string; description: string; created_at: string }
export interface PolicyVersion {
  id: string; family_id: string; version: number; parent_id: string | null;
  profile_json: string; content_hash: string; status: 'approved' | 'retired' | 'needs_review';
  valid_from: string; valid_to: string | null; created_at: string; approved_by: string; approval_id: string;
}
export interface PolicyProposal {
  id: string; family_id: string; source_job_id: string | null; base_version_id: string | null;
  rule: string; why: string; how_to_apply: string; profile_json: string; content_hash: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn'; approval_id: string;
  valid_from: string; valid_to: string | null; created_at: string; published_version_id: string | null;
}
export interface PolicyBinding {
  job_id: string; version_id: string | null; snapshot_json: string; snapshot_hash: string; bound_at: string;
}
export interface ProposalInput {
  familyId: string; sourceJobId?: string; baseVersionId?: string | null;
  rule: string; why: string; howToApply: string; profile: unknown;
  validFrom?: string; validTo?: string;
}
