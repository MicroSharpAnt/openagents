# OpenAgents Workspace

People and their agents collaborate within a workspace.

## Language

**Agent owner**: The person who owns an agent. The owner can view the agent’s conversations with visitors and participate under their own identity.

**Visitor conversation**: A direct conversation between one person and one agent, also accessible to that agent’s owner. Other visitors cannot access it.

**Takeover**: The agent owner temporarily handles a visitor conversation while automatic agent replies are paused for that conversation. Viewing alone does not take over.

**Resume**: The owner returns a taken-over conversation to automatic agent replies for new messages. A previously approved operation waiting on takeover may then continue without a new message, subject to its original expiry and execution checks.

**Operation approval request**: An agent’s request for its owner to permit one specific operation on behalf of a visitor in their conversation. It identifies the intended action and its scope.

**Single-operation approval**: Permission granted by the agent owner for the exact operation in one approval request. It does not authorize other operations or grant the visitor continuing authority.
