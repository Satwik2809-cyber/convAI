# ConvAI Code to Requirements Mapping Report

## 1. Introduction

This report provides a mapping between the functional requirements of the ConvAI platform, as derived from the requirements document, and the observed implementation within the provided codebase. The objective is to demonstrate how the architectural components and code structure align with the stated goals of enabling natural human-digital system interaction while ensuring secure, policy-compliant, and deterministic AI-driven actions.

## 2. ConvAI Architecture Overview (Code Perspective)

The core orchestration of the ConvAI platform is encapsulated within the system flow, which serves as the canonical entry point for all external interactions. This defines an invariant execution order, emphasizing a Planner → Governance → Identity Gate → Runtime flow. Key stages in this process include:

1.  **Determinism Guard:** Ensures deterministic execution boundaries.
2.  **Input Processing:** Canonicalization of raw user input.
3.  **Interpretation:** Evaluation of user intent using various interpreters.
4.  **Context Resolution:** (Currently stubbed) for contextual understanding.
5.  **Policy Evaluation:** Authoritative assessment against defined policies.
6.  **Execution Directive Resolution:** Derivation of executable instructions based on policy decisions.
7.  **Controlled Execution:** The sole mechanism for executing actions within the system.
8.  **Trace Assembly:** Comprehensive recording of the entire interaction for auditability.

This architecture strongly supports a "trace-first" design, ensuring that every step of an interaction is recorded, and a "policy-authoritative" execution model, where governance precedes any action.

## 3. Mapping Requirements to Code Implementation

### 3.1. Pillar 1: AI Interaction & Execution Layer

This pillar focuses on enabling natural, conversational interaction and intent capture. The codebase reflects this through several components:

*   **Voice and Chat-Based Interaction:**
    *   The `runInteraction.ts` function accepts `rawInput` containing `raw_text`, `role`, and `session_id`, indicating its ability to process textual input from various sources.
    *   The `src/ingestion/channels` directory contains adapters like `HttpAdapter.ts`, `VoiceAdapter.ts`, and `WhatsAppAdapter.ts`, suggesting support for diverse communication channels, including voice and chat.

*   **Intent-Driven Flows:**
    *   The `InterpretationEngine.ts` (located in `src/interpretation`) is responsible for evaluating user input to determine intent. It takes an `InputObject` and a list of `Interpreter` instances.
    *   `DeterministicInterpreter.ts` and `LLMInterpreter.ts` are identified as specific implementations of `Interpreter`, indicating a dual approach to intent recognition: one for predictable, rule-based interpretation and another leveraging large language models for more nuanced understanding.
    *   `InterpretationGate.ts` arbitrates between the results of multiple interpreters, ensuring a cohesive understanding of user intent.

*   **Conversational Navigation & Action Initiation:**
    *   The `ControlledExecutor.ts` (`src/core/runtime`) is the exclusive component for executing actions, ensuring that all system modifications are channeled through a controlled mechanism.
    *   `ExecutionDirectiveResolver.ts` (`src/core/runtime`) translates policy decisions into concrete `ExecutionDirective` objects, which then guide the `ControlledExecutor`.
    *   The `src/products` directory, with subdirectories like `school-health` and `tutor`, suggests a modular approach to defining specific product capabilities and their associated handlers (`CapabilityHandler.ts`, `ProductExecutionAdapter.ts`), which would facilitate conversational navigation and action initiation within defined domains.

### 3.2. Pillar 2: Deterministic Decision + Policy Enforcement Engine

This pillar ensures enterprise control, predictability, auditability, and policy adherence. The codebase implements these aspects rigorously:

*   **Intent Validation & Policy Enforcement:**
    *   `PolicyEvaluator.ts` (`src/core/policy`) is the authoritative component for policy assessment. It evaluates the `InterpretationResult` against a `PolicyResult`.
    *   The `PolicyEvaluator` explicitly checks `policy.permitted`, `interpretation.ambiguity_flag`, and `interpretation_confidence` to make decisions, which can result in `BLOCK`, `REQUIRE_HUMAN_REVIEW`, or `ALLOW` (`DataQualityPolicyDecision`). This directly addresses the need for validating intent and enforcing business rules.
    *   The `src/core/policy` directory contains various policy-related files such as `CapabilityPermission.ts`, `ConfidencePolicy.ts`, `DataQualityPolicy.ts`, and `RoleCapabilityPolicy.ts`, indicating a comprehensive framework for defining and applying diverse policy types.

*   **Structured Action Conversion:**
    *   The `ExecutionDirectiveResolver.ts` plays a crucial role here by converting the `policyDecision` (which is a structured outcome of policy evaluation) into an `ExecutionDirective`. This ensures that unstructured AI outputs are transformed into structured, approved actions before execution.

*   **Non-Compliance Handling:**
    *   The `PolicyEvaluator.ts` directly implements mechanisms to handle non-compliant responses by returning `BLOCK` or `REQUIRE_HUMAN_REVIEW` based on policy rules and interpretation confidence. This prevents unauthorized or risky actions.
    *   `GovernanceViolation.ts` and `GovernanceViolationFactory.ts` (`src/core/runtime`) further support the structured reporting and handling of policy breaches.

*   **Outcome Assurance (Predictability, Auditability, Replayability, Safety):**
    *   `DeterminismGuard.ts` (`src/core/runtime`) is explicitly called at the very beginning of `runInteraction.ts` to assert determinism, a foundational requirement for predictable outcomes.
    *   The `TraceRecord.ts` schema (`src/core/schemas`) and the assembly of a comprehensive `TraceRecord` at the end of `runInteraction.ts` (including `interaction_id`, `metadata`, `input`, `intent`, `context`, `policy`, `decision`, `action`, and `response`) directly support auditability and replayability. The `src/core/replay` directory further emphasizes this with components like `ReplayAuthorization.ts`, `ReplayExecutionGate.ts`, and `ReplayStoreContract.ts`.
    *   The entire flow, with policy evaluation preceding execution, inherently ensures safe execution across systems, as AI 
never acts alone and is always governed by policy.

## 4. Integrated Workflow: The Governed Flow

The `runInteraction.ts` file is the direct implementation of the described governed flow:

1.  **User Interaction:** Handled by the `rawInput` parameter and the ingestion adapters (`HttpAdapter.ts`, `VoiceAdapter.ts`, `WhatsAppAdapter.ts`).
2.  **AI Interpretation:** Performed by `InterpretationEngine.ts` utilizing `DeterministicInterpreter.ts` and `LLMInterpreter.ts`.
3.  **ConvAI Decision Engine Validation:** Implemented by `PolicyEvaluator` and `ExecutionDirectiveResolver`, which collectively validate intent and structure the action based on policies.
4.  **Compliant Execution:** Ensured by `ControlledExecutor.ts`, which only executes actions derived from a policy-approved `ExecutionDirective`.
5.  **Outcome Communication:** The `ResponseObject` is part of the `TraceRecord`, and `ResponseComposer.ts` (`src/core/response`) would likely be responsible for formatting this back to the user.

## 5. Lead Use Case: E-commerce and Generalizability

The modular structure within `src/products` (e.g., `school-health`, `tutor`) demonstrates the platform's generalizability. While an explicit `e-commerce` product is not present in the provided directory listing, the framework for defining `Capability.ts`, `CapabilityHandler.ts`, and `ProductExecutionAdapter.ts` allows for the easy integration of e-commerce-specific logic. The policy enforcement mechanisms (`PolicyEvaluator.ts`, `DataQualityPolicy.ts`, etc.) are inherently domain-agnostic, allowing them to be applied to diverse scenarios like e-commerce, education, or healthcare, thus fulfilling the requirement for a generalized and standard layer for AI-driven actions.

## 6. Conclusion

The ConvAI codebase demonstrates a strong alignment with the requirements outlined in the architectural specification. The architecture prioritizes determinism, policy enforcement, and comprehensive tracing, effectively addressing the challenges of broken interaction and untrustworthy AI actions. The modular design further supports the platform's generalizability across various high-stakes domains.
