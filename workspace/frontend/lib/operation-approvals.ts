/** Server-issued capabilities are authoritative; workspace roles never grant a decision. */
export interface OperationApproval {
  id: string;
  session_id: string;
  agent_name: string;
  owner_email: string;
  visitor_email: string;
  operation: { kind: 'move'; root: string; source: string; destination: string; expected_state: string };
  operation_digest: string;
  status: 'pending' | 'approved' | 'executing' | 'succeeded' | 'failed' | 'invalidated' | 'rejected' | 'withdrawn' | 'expired';
  expires_at: string;
  created_at: string;
  result: unknown;
  paused: boolean;
  can_decide: boolean;
  can_withdraw: boolean;
}
export type OperationDecision = 'approve' | 'reject' | 'withdraw';
