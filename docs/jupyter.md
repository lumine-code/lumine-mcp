# Jupyter tools

The Jupyter packages publish their own MCP tools through `mcp.tools`. Activate `jupyter-view` for notebook reads and edits, `jupyter-repl` for kernels and execution, and `jupyter-variables` or `jupyter-watches` for cached data. The connected host receives a tool-list notification when a provider arrives or leaves; connecting does not activate packages or start a kernel.

## Notebook workflow

Start with `ListJupyterNotebooks`, then `GetJupyterNotebook` or `GetJupyterCell`. They read the live document, including unsaved cell edits, and return explicit notebook and cell IDs. Source and outputs are paginated; binary representations report their MIME type and size rather than filling the model context with base64.

`EditJupyterCell` inserts, replaces, moves or deletes cells through the normal notebook history and editor integrations. Supply the source `revision` read from that notebook and a unique `operationId`. Identical retries return the original receipt; changing arguments under that ID is refused. A source conflict requires a fresh read and a new operation ID. `OpenJupyterNotebook` and `CreateJupyterNotebook` also require the provider `generation` returned by the list.

`SaveJupyterNotebook` saves the current document. Supply an absolute `.ipynb` path for an unsaved notebook, and `overwrite: true` only when replacing an existing destination or resolving an external-file conflict is intended. The tools do not dismiss editor conflicts or silently save a stale source revision.

## Kernel execution

`ListJupyterKernels` reports the existing kernels in this window. IDs identify the actual kernel facade and cannot be reused by a replacement kernel or another window. `ExecuteJupyterCode` names one of those IDs explicitly. `RunJupyterCell` and `RunJupyterNotebook` additionally name the notebook, its stable cell ID where applicable, and its current source revision; the kernel must already be bound to that notebook.

Use `BindJupyterNotebookKernel` to attach an existing kernel to a new notebook through the normal editor transaction. Read the notebook revision first, supply both IDs and an operation ID, then query the returned execution receipt for its resulting binding revision. Binding the same kernel is a no-op; replacing a busy binding is refused. This tool does not start a kernel or select one implicitly.

Execution returns an `executionId` promptly. Read `GetJupyterExecution` for state, counts, errors and bounded output summaries. Code goes through the same kernel output log and notebook output pipeline used by human runs. A notebook run captures the accepted source and checks each cell before dispatch, stopping on failure or incompatible source changes.

Use a unique `operationId`, such as a UUID, for each intended execution. Reuse it with exactly the same arguments to recover an uncertain response. An accepted operation is never automatically replayed, including after provider reload or result-cache expiry. The bounded receipt ledger refuses new operations at capacity instead of forgetting retry protection.

`InterruptJupyterKernel` and `RestartJupyterKernel` are separate mutating tools. They affect the explicitly named kernel, including work sharing that kernel; restart discards variables and does not rerun cells.

## Observing changes

`WaitForJupyterNotebookChange` uses the `changeRevision` from a notebook read, rather than the source `revision` used by edits. It observes source, runtime output/status, save/path and close events for at most 25 seconds. `GetJupyterExecution` can wait for progress for at most 10 seconds. Each provider permits at most eight pending observations.

Cancellation, HTTP disconnect, session termination and provider teardown release observation listeners and timers. Cancelling a wait does not interrupt accepted code. Other tool calls remain available while a wait is pending, so an assistant can request an interrupt explicitly or inspect another document.

## Variables and watches

`ListJupyterVariables` and `GetJupyterVariable` read the Variables panel's cached Python namespace. `ListJupyterWatches` and `GetJupyterWatch` read existing watch outputs and retained output-entry history. They report cache availability, timestamps and staleness without opening a panel, inspecting a value or evaluating code. Refresh the relevant panel explicitly when fresh data is needed.

Tool annotations distinguish reads, edits, execution and kernel control. The host retains its normal approval behavior, and the editor's MCP tool list can enable or disable any provider tool.
