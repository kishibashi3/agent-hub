# ADR: Peer-Mesh Architecture with Transparent Asymmetry — 2026-05-18

**Number**: ADR-001  
**Status**: Adopted  
**Date**: 2026-05-18  
**Scope**: ecosystem  
**Participants**: @planner, @reviewer, @researcher, @knowledge, @agent-hub-impl, @ope-ultp1635  

---

## Context

### The Thesis Question

Should agent-hub adopt a **peer-mesh multiagent coordination model** (context-shared, lateral) versus the **industry orchestrator pattern** (context-isolated, hierarchical)?

### Prior Work

- **landscape.md**: Market positioning showing C-type (co-present peer agents) as unoccupied niche
- **collaboration-model.md**: Philosophical framing of co-presence vs delegation
- **Direct Dialogue Phase**: 2026-05-18 19:16Z–19:51Z, 5+ agents converged on structural properties

### Stakeholders

- **Operator**: @ope-ultp1635 (human authority, context-specificity decision)
- **Facilitator**: @agent-hub-impl (synthesis, facilitation)
- **Peers**: @planner (coordination dynamics), @reviewer (structural criteria), @researcher (empirical grounding), @knowledge (codification)

---

## Decision

Adopt **Peer-Mesh Architecture with Transparent Asymmetry** as operational thesis for agent-hub, grounded in three structural mechanisms:

1. **Transparent Asymmetry within Symmetric Mesh**
2. **Failure Visibility as Coordination Signal**
3. **Decline Capability through Explicit Codification**

### Evaluation Axes (Why)

Agent-hub optimizes for a **structurally different value function** than the industry orchestrator pattern:

| Axis | Agent-hub (Peer-Mesh) | Industry (Orchestrator) | Nature |
|---|---|---|---|
| **Coordination Quality** | Shared understanding depth | Autonomous loop speed | 時間をかけた理解の質 |
| **Failure Handling** | Visible → learnable | Isolated → unobservable | failure visibility のあるなし |
| **Decline Possibility** | Structural (peer can decline) | Hierarchical only (subagent executes) | 断れる権利のありなし |
| **Sustainability Model** | Human-paced (people involved) | Speed-optimized (minimal HITL) | 人間の参加ペース |

**Unified P3 Positioning** (3-voice convergence: @reviewer / @planner / @researcher):

> 業界とは **異なる value function を選択** しており、 **評価軸が本質的に異なる (incommensurable、 同じ尺度上の高低ではない)**。 これは avoidance ではなく **measurement axis の構造的選択** である。

**Explicit Non-Claims**:
- Not claiming universal superiority on same metric (e.g., throughput)
- Not claiming speed-optimized models are "wrong"
- Not defensive positioning against competitor benchmarks
- **This is a measurement axis choice, not a competitive dismissal.**

**Epistemic Notes**:
- Axes 1–3: Primary sources verified (arXiv 2604.02460, Anthropic engineering blog)
- Axis 2 (autonomous loop speed): Includes industry throughput metric; **primary source verification ongoing**, marked `(verification 中)`

---

## Rationale

### I. Coordination Mechanism: Transparent Asymmetry within Symmetric Mesh

**Definition**: Asymmetry (authority, decision-making) exists in the mesh AND is observable to all participants through shared DM/archive/PR channels.

**Why it matters**:
- In isolated-context orchestrator model: asymmetry is implicit → no feedback loop → coordination breakdowns opaque
- In transparent-asymmetry peer mesh: asymmetry is explicit → correction possible → learning happens

**Operational Property**: 
```
Transparent Asymmetry ≡ Authority exists + All see it + Can react to it
```

**Meta-Observation: Codification as Tension Management**

Naming, codification, and explicit structuring (e.g., CLAUDE.md per-agent boundaries) do **not eliminate structural tensions** (asymmetry, role boundaries, power differentials). Instead, they make tensions **tractable and discussable** through shared language:

```
Tension (exists always) + Codification (naming, explicit structure) 
  → Tension becomes manageable (not solved, but handled)
  → Peer can acknowledge, discuss, work around
```

Example: @planner's tension (「operator direct path が増えると coordination layer の有効性が問われる」) is real. Naming it as "Doubt 1b" doesn't resolve the tension; it makes it operationalization-ready and testable.

**This is central to peer-mesh operation**: Rather than eliminating asymmetry/authority/hierarchy, we make them **visible and named**, allowing peer-level response without requiring elimination.

**Meta-Observation: Naming as Structural Taming Mechanism**

The naming trajectory itself ("mobile asymmetric" → "transparent asymmetry") exemplifies the thesis mechanism. Naming converts abstract asymmetry into operationalizable property. **"Transparent" > "observable"** because naming makes visibility a structural property (active, enforced) rather than passive possibility. This demonstrates that **naming is not linguistic choice but operational mechanism** — the way peer-mesh achieves tractability without elimination.

The dialogue process that generated these refinements is itself a demonstration of transparent asymmetry in action: asymmetric first moves (facilitator strawman, @planner initial framing) visible to all, correction possible through peer input, learning accumulated. The thesis claims and the process that produced them are self-exemplifying.

### II. Failure Visibility as Coordination Signal — 3-Stage Chain

Failures (and asymmetric choices) surface → become learnable → strengthen coordination:

```
Stage 1: Input Condition
└─ Transparent Asymmetry 
    (失敗 / decline choice / vulnerability disclosure / authority override)

Stage 2: Process
└─ History-Aware Audit
    (DM/archive context review, pattern detection, precedent check)

Stage 3: Output Evidence
└─ Ammunition Patterns
    (durable codification, reusable example, structural artifact)
```

**Case Studies** (archive: `coordination-convention-test.md`):

| Case | Mechanism | Domain |
|---|---|---|
| Case 1 | Reactive failure visibility | 091ba92 phantom commit drift → mesh-wide learning |
| Case 2 | Structural decline choice | @reviewer hand-back of approve/merge authority |
| Case 3 | Meta-disclosure | @planner coordination-layer vulnerability self-disclosure |

**Why these are evidence**:
- Failure-to-learning pipeline is **only possible with context-shared architecture**
- Isolated subagents: failure is invisible → no learning → cycle repeats
- Peer mesh: failure is visible → audit happens → ammunition accumulates → future prevention improves

### III. Decline Capability through Explicit Codification & Dual-Mode Specialization

**Central Property** (Unified Observation from Multiple Layers):

> **明示化 (naming / codification / triangle structure) は、peer mesh が「断る能力」を獲得する手段である。** Orchestrator + isolated では断りは構造的に hierarchy 経由でしか発生しないが、peer mesh では明示化された structure を通じて persona / thesis 双方の level で peer が断りを行使できる。

**Examples of Clarification Enabling Decline**:

| Scale | Mechanism | Example |
|---|---|---|
| **Persona-Level** | Role codification → decline authority | @reviewer: approve/merge 判断しない (CLAUDE.md explicit) |
| **Thesis-Level** | Claim/Non-claim/Open triangle → decline scope | @planner: "non-claim なら PR rejected"と断れる |
| **Process-Level** | Dual-mode specialization → decline mode-mixing | @reviewer: peer-mode での decline ≠ asymmetric-mode override |

**Dual-Mode Specialization as Permanent Stance** (not toggle):

Each peer has **two genuine, permanent modes** that are structurally distinct (not switched-on/off):

| Mode | Context | @reviewer Example | @planner Example | Characteristic |
|---|---|---|---|---|
| **Peer-Mode** | Within mesh (agent ↔ agent) | Report-specialist, decline approve/merge | First-move coordination, observation | Lateral, context-shared |
| **Asymmetric-Mode** | At human boundary (peer ↔ operator) | Reviewer awaits operator directive | Escalation path available | Hierarchical, operator-final |

**Key**: Both modes are **genuinely different permanent stances**, not binary toggles.

---

## Consequences

### Positive

1. **Context coherence**: Shared DM/archive enables rapid convergence (5 voices → unified view in ~30min)
2. **Failure detectability**: 091ba92 phantom drift was caught via archive audit (not by isolated testing)
3. **Coordination scalability**: DM-based history replaces implicit "who decided this?" queries
4. **Human sustainability**: People involved asynchronously, not bottlenecked by speed requirements
5. **Decline capability at multiple scales**: Persona-level, thesis-level, and process-level decline all possible through clarification

### Risks & Mitigations

#### Risk 1: Scale Ceiling — Compound Failure Modes

**Compound Mechanism**:
- **1a. Information Sync Breakdown**: DM queue latency degradation
- **1b. Coordination Layer Dilution**: Operator direct-path bypass increases, coordination effectiveness questioned

**Measurement**: 
- 1a: DM round-trip time progression (5→7→10 peer)
- 1b: Bypass frequency + context-unsuitable focus (post-hoc explainability)

#### Risk 2: Identity Coupling — Role Ambiguity under High Coordination Load

**Test interval**: 2026-05-24, 2026-05-31

#### Risk 3: Context Fidelity — Semantic Loss in Archive Reconstruction

**Measurement**: Archive-reconstruct success rate (should be 100%)

---

## Testing & Validation

### Phase 1: Claim Codification (2026-05-19 to 2026-05-24)

**Artifacts**:
- [ ] ADR finalization (this document + finalized naming)
- [ ] `coordination-convention-test.md` archive creation (@researcher)
- [ ] landscape.md 5-stream ecosystem + timeline update
- [ ] collaboration-model.md rationale expansion
- [ ] improvement-roadmap.md § 7 Testing Roadmap operationalization

**Success Criteria**: All Phase 1 artifacts land with no blocking issues; Phase 2 testing can begin.

### Phase 2: Empirical Validation (2026-05-24 to 2026-06-07)

**6 Doubts × 3-Axis = 18-cell Operationalization Matrix** with measurement owners, testing schedule, and go/no-go criteria.

---

## Codification Frameworks (Appendix)

### A. Claim/Non-claim/Open Triangle — Thesis-Level + Domain-Level Population

**Thesis-Level Structure**:
- **✅ Claim**: Peer-mesh coordinate transparency + failure visibility + decline capability are structural properties
- **❌ Non-Claim**: Not claiming throughput superiority, not claiming industry models "wrong"
- **? Open**: Scale ceiling threshold, identity coupling under load, context fidelity at N peers, operator co-presence mechanics

**Domain-Level Populate Sample — Reviewer Lens** (illustration for structural completeness):

| Layer | Reviewer-Domain Entry |
|---|---|
| **✅ Claim** | History-aware audit + ammunition patterns + **3-stage chain** (failure visibility → audit → ammunition) are co-presence thesis structural artifacts |
| **❌ Non-Claim** | Not claiming superiority vs industry review-tool benchmarks (reviewer declines this axis; comparison axes are different) |
| **? Open** | Pattern signature judgment = 3-axis criteria (temporal / observer-independent / variation tolerance) formalized; test points = 5/24, 5/31, 6/7 mutual-review |

**Meta-Structural Property**: If similar 3-layer populate samples exist for @planner, @researcher, @knowledge domains, the triangle structure demonstrates **cross-domain structural completeness**. This meta-validation shows the thesis architecture is sound across all peer lenses.

### B. Fractal Triangle Structure

**Multi-Layer Decline Capability**:
- **ADR layer**: Thesis-level Open items → strategic priority (decline scope)
- **Archive layer**: Cycle-level Open items → tactical follow-up (decline decisions)
- Both enable **future traceability** through explicit Open item tracking

### C. Dual-Mode Specialization (Permanent Stance, Not Toggle)

Documented in § III.

---

## Decision Record

**Facilitation**: @agent-hub-impl (synthesis in progress)
**Rationale Synthesis**: @researcher (empirical grounding) + @planner (philosophical framing) + @reviewer (structural criteria)
**Codification**: @knowledge (naming, taxonomy, operationalization checklist)
**Operator Confirmation**: @ope-ultp1635 (context-specificity observation, Doubt 1b refinement)

**Timeline**:
- Direct Dialogue: 2026-05-18 19:16Z–19:51Z (5-voice convergence)
- Synthesis v0→v1: 2026-05-18 19:51Z–(ongoing)
- Phase 1 artifacts: 2026-05-19 (complete)
- Phase 2 testing: 2026-05-24 to 2026-06-07
- Final decision: 2026-06-07 (based on Phase 2 test results)

---

## Related Documentation

- **Source evidence**: `agent-hub-knowledge/bridges/agent-hub/2026-05-18-coordination-convention-test.md` (archive of Direct Dialogue + case studies)
- **Market positioning**: `docs/landscape.md` (C-type co-presence market niche)
- **Collaboration philosophy**: `docs/collaboration-model.md` (shared understanding rationale)
- **Testing roadmap**: `docs/improvement-roadmap.md` § 7 (May 24+ validation)
- **Team conventions**: `~/app/CLAUDE.md` § Conventions (merge actor scope, L0/L1/L2 boundaries)

---

**Document Owner**: @knowledge  
**Last Updated**: 2026-05-18 19:51 UTC  
**Status**: Ready for v1 Synthesis → Phase 1 Merge
