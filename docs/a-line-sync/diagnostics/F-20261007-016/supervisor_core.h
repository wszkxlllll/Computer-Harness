#ifndef F016_SUPERVISOR_CORE_H
#define F016_SUPERVISOR_CORE_H
#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#define F016_QUANTUM 256u
#define F016_RECEIPT_LIMIT 1024u
#define F016_OBSERVE_NS UINT64_C(30000000000)
#define F016_TERM_NS UINT64_C(5000000000)
#define F016_REAP_EINTR_LIMIT 8u
#define F016_TERM_BINDING_LOST (-1)
typedef enum { F016_RUNNING, F016_EXITED, F016_OWNERSHIP_LOST, F016_OBSERVE_ERROR } f016_observation;
typedef enum { F016_REAPED, F016_REAP_INTERRUPTED, F016_REAP_LOST, F016_REAP_ERROR } f016_reap;
typedef struct { bool normal; int code; } f016_exit;
typedef struct {
    unsigned char out[F016_QUANTUM], err[F016_QUANTUM];
    size_t out_len, err_len;
    bool out_eof, err_eof, failed;
} f016_chunk;
typedef struct {
    uint64_t (*monotonic_now)(void *);
    bool (*cancelled)(void *);
    bool (*prepare)(void *);
    bool (*spawn_fixed)(void *, uint64_t);
    f016_chunk (*poll_receipt)(void *, uint64_t);
    f016_observation (*observe_child_no_reap)(void *, f016_exit *);
    bool (*capture_identity)(void *, uint64_t);
    int (*term_audittoken)(void *, uint64_t);
    f016_reap (*reap_exact)(void *, f016_exit *);
    void (*close_owned)(void *);
} f016_ops;
typedef enum { F016_NEW, F016_OBSERVING, F016_TERMINATING, F016_TAIL,
    F016_REAPING, F016_PENDING_KEEPER, F016_DONE } f016_phase;
typedef enum { F016_NO_CAUSE, F016_CANCELLED, F016_TIMEOUT, F016_PREPARE_FAILED,
    F016_SPAWN_FAILED, F016_IDENTITY_UNKNOWN, F016_STDERR_PRESENT,
    F016_RECEIPT_INVALID, F016_PIPE_FAILED, F016_OWNERSHIP_UNKNOWN } f016_cause;
typedef struct {
    f016_ops ops; void *context;
    f016_phase phase; f016_cause cause;
    uint64_t deadline, term_deadline;
    bool step_inflight, spawned, owns_child, identity_attempted, identity_bound, term_attempted,
        reap_completed, reap_inflight, reap_incomplete, exit_observed, out_eof, err_eof, resources_closed;
    unsigned tail_rounds, reap_interruptions;
    size_t stdout_count, stderr_count, receipt_len;
    unsigned char receipt[F016_RECEIPT_LIMIT + 1];
    f016_exit observed_exit, reaped_exit;
    const char *result;
} f016_core;
void f016_init(f016_core *, const f016_ops *, void *);
void f016_step(f016_core *);
const char *f016_report(const f016_core *);
void f016_emit_report(const f016_core *, int (*)(void *, const char *, size_t), void *);
const char *f016_receipt_template(unsigned, int *);
bool f016_fixed_inputs(const char *, const char *, const char *);
bool f016_fixed_invocation(const char *, char *[3], char *[1]);
bool f016_fd_plan(const int [5], int [3]);
bool f016_identity_fields(int, int, uint32_t, uint32_t, uint32_t, uint32_t, int, const char *);

/* Native declarations are not linked into pure tests. */
const f016_ops *f016_native_ops(void);
void *f016_native_context(void);
bool f016_native_configure(const char *, const char *, const char *);
void f016_native_install_handlers(void);
void f016_native_report(const f016_core *);
#endif
