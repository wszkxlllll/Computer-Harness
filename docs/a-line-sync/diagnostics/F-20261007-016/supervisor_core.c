#include "supervisor_core.h"
#include <string.h>
#include <stdio.h>

static const char fixed_child[]="/private/tmp/F013-app-prep-20261007.Gw84nt/HarnessF005Diagnostic.app/Contents/MacOS/cua-driver-local";
bool f016_fixed_inputs(const char *child,const char *sha,const char *cdhash) {
    return child && sha && cdhash && !strcmp(child,fixed_child)
        && !strcmp(sha,"46db151bd19763013eda935170be0fe1d408d9b7719d0aa4b0e0d0c1a72ed53e")
        && !strcmp(cdhash,"8f63caaee65f4cd54eb740b5c86631f5ce97002c");
}
bool f016_fixed_invocation(const char *child,char *argv[3],char *envp[1]) {
    if(!child || strcmp(child,fixed_child))return false;
    argv[0]=(char *)fixed_child;argv[1]=(char *)"diagnostic-preflight-only";argv[2]=NULL;envp[0]=NULL;return true;
}
bool f016_fd_plan(const int fds[5],int sources[3]) {
    for(unsigned i=0;i<5;i++) {
        if(fds[i]<3)return false;
        for(unsigned j=0;j<i;j++)if(fds[i]==fds[j])return false;
    }
    sources[0]=fds[0];sources[1]=fds[2];sources[2]=fds[4];return true;
}
bool f016_identity_fields(int actual_pid,int child_pid,uint32_t euid,uint32_t expected_uid,
    uint32_t count,uint32_t expected_count,int pidversion,const char *path) {
    return child_pid>0 && actual_pid==child_pid && euid==expected_uid && count==expected_count
        && expected_count>0 && pidversion>0 && path && !strcmp(path,fixed_child);
}

#define R(outcome,self,ax,sr) "{\"schema\":\"harness.diagnostic_preflight.v1\",\"outcome\":\"" outcome "\",\"selfIdentityValidated\":" self ",\"accessibility\":" ax ",\"screenCapture\":" sr ",\"principalVerified\":false,\"readyForDispatch\":false}\n"
static const char *const receipts[13] = {
 R("observed_unverified","true","true","true"),
 R("permissions_not_granted","true","true","false"),
 R("permission_status_unknown","true","true","null"),
 R("permissions_not_granted","true","false","true"),
 R("permissions_not_granted","true","false","false"),
 R("permission_status_unknown","true","false","null"),
 R("permission_status_unknown","true","null","true"),
 R("permission_status_unknown","true","null","false"),
 R("permission_status_unknown","true","null","null"),
 R("identity_unknown","false","null","null"),
 R("identity_rejected","false","null","null"),
 R("report_unknown","false","null","null"),
 R("invalid_arguments","false","null","null")
};
const char *f016_receipt_template(unsigned i, int *code) {
    if (i >= 13) return NULL;
    if (code) *code = i == 0 ? 0 : i == 12 ? 64 : 2;
    return receipts[i];
}
static void wipe(void *p, size_t n) { volatile unsigned char *v=p; while(n--) *v++=0; }
static void lock_cause(f016_core *s, f016_cause cause) { if(s->cause==F016_NO_CAUSE) s->cause=cause; }
static void active(f016_core *s) {
    if(s->ops.cancelled(s->context)) lock_cause(s,F016_CANCELLED);
    if(s->deadline && s->ops.monotonic_now(s->context)>=s->deadline) lock_cause(s,F016_TIMEOUT);
}
static void done(f016_core *s, const char *result) {
    s->result=result; s->phase=F016_DONE;
    if(!s->resources_closed) { s->resources_closed=true; s->ops.close_owned(s->context); }
    wipe(s->receipt,sizeof(s->receipt)); s->receipt_len=0;
}
static void pending(f016_core *s) {
    s->phase=F016_PENDING_KEEPER;
    s->result=s->owns_child?(s->reap_incomplete?"retained_child_reap_pending":"retained_child_pending"):"ownership_unknown";
    wipe(s->receipt,sizeof(s->receipt)); s->receipt_len=0;
}
static size_t bounded_count(size_t n,size_t addition) {
    const size_t cap=F016_RECEIPT_LIMIT+1;
    return addition>=cap || n>=cap-addition ? cap : n+addition;
}
static void drain(f016_core *s,bool retain) {
    f016_chunk chunk=s->ops.poll_receipt(s->context,s->phase==F016_TERMINATING?s->term_deadline:s->deadline);
    active(s);
    if(chunk.failed || chunk.out_len>F016_QUANTUM || chunk.err_len>F016_QUANTUM) {
        lock_cause(s,F016_PIPE_FAILED); wipe(&chunk,sizeof(chunk)); return;
    }
    s->stdout_count=bounded_count(s->stdout_count,chunk.out_len);
    s->stderr_count=bounded_count(s->stderr_count,chunk.err_len);
    if(chunk.err_len) lock_cause(s,F016_STDERR_PRESENT);
    if(s->stdout_count>F016_RECEIPT_LIMIT) lock_cause(s,F016_RECEIPT_INVALID);
    if(retain && s->cause==F016_NO_CAUSE) {
        if(s->receipt_len+chunk.out_len>F016_RECEIPT_LIMIT) lock_cause(s,F016_RECEIPT_INVALID);
        else {
            memcpy(s->receipt+s->receipt_len,chunk.out,chunk.out_len); s->receipt_len+=chunk.out_len;
            bool possible=false;
            for(unsigned i=0;i<13;i++)if(s->receipt_len<=strlen(receipts[i])
                && !memcmp(s->receipt,receipts[i],s->receipt_len)){possible=true;break;}
            if(!possible)lock_cause(s,F016_RECEIPT_INVALID);
        }
    }
    s->out_eof |= chunk.out_eof; s->err_eof |= chunk.err_eof;
    wipe(&chunk,sizeof(chunk));
}
static f016_observation observe(f016_core *s) {
    f016_exit value={false,0};
    f016_observation o=s->ops.observe_child_no_reap(s->context,&value);
    active(s);
    if(o==F016_EXITED) {s->exit_observed=true;s->observed_exit=value;s->phase=F016_TAIL;s->tail_rounds=0;}
    else if(o==F016_OWNERSHIP_LOST || o==F016_OBSERVE_ERROR) {
        s->owns_child=false; lock_cause(s,F016_OWNERSHIP_UNKNOWN);pending(s);
    }
    return o;
}
static void finish_reap(f016_core *s) {
    if(s->reap_inflight || s->reap_completed || s->reap_incomplete)return;
    f016_exit value={false,0};
    s->reap_inflight=true; /* Before Ops side effect: synchronous reentry cannot reap again. */
    f016_reap r=s->ops.reap_exact(s->context,&value);
    s->reap_inflight=false;
    active(s);
    if(r==F016_REAP_INTERRUPTED) {
        if(++s->reap_interruptions>=F016_REAP_EINTR_LIMIT) {s->reap_incomplete=true;pending(s);}
        return;
    }
    if(r!=F016_REAPED) {s->owns_child=false;lock_cause(s,F016_OWNERSHIP_UNKNOWN);pending(s);return;}
    s->reap_completed=true;s->owns_child=false;s->reaped_exit=value;
    if(!value.normal) {done(s,"interrupted");return;}
    if(s->cause!=F016_NO_CAUSE) {done(s,"cleanup_complete_unverified");return;}
    if(!s->out_eof || !s->err_eof || s->stderr_count || !s->observed_exit.normal
        || value.code!=s->observed_exit.code) {done(s,"receipt_exit_invalid");return;}
    for(unsigned i=0;i<13;i++) {
        int code=0;const char *text=f016_receipt_template(i,&code);
        if(strlen(text)==s->receipt_len && memcmp(text,s->receipt,s->receipt_len)==0 && value.code==code) {
            done(s,i==0?"preflight_observed_unverified":"known_refusal");return;
        }
    }
    done(s,"receipt_exit_invalid");
}
void f016_init(f016_core *s,const f016_ops *ops,void *context) {
    memset(s,0,sizeof(*s));s->ops=*ops;s->context=context;s->phase=F016_NEW;s->result="prepared";
}
static void step_internal(f016_core *s) {
    if(s->phase==F016_DONE) return;
    if(s->phase==F016_NEW) {
        active(s);
        if(s->cause!=F016_NO_CAUSE) {done(s,"prelaunch_refused");return;}
        bool ready=s->ops.prepare(s->context);active(s);
        if(!ready) lock_cause(s,F016_PREPARE_FAILED);
        if(s->cause!=F016_NO_CAUSE) {done(s,"prelaunch_refused");return;}
        uint64_t start=s->ops.monotonic_now(s->context);
        if(start>UINT64_MAX-F016_OBSERVE_NS) {lock_cause(s,F016_PREPARE_FAILED);done(s,"prelaunch_refused");return;}
        s->deadline=start+F016_OBSERVE_NS;
        /* Latch before the side effect: one request can never spawn twice. */
        s->phase=F016_OBSERVING;
        bool launched=s->ops.spawn_fixed(s->context,s->deadline);active(s);
        if(!launched) {lock_cause(s,F016_SPAWN_FAILED);done(s,"prelaunch_refused");return;}
        s->spawned=true;s->owns_child=true;active(s);s->result="observing";
    }
    if(s->phase==F016_PENDING_KEEPER) {
        drain(s,false);
        /* An interrupted, already-observed exit retains the exact child but
           exhausts automatic reap authority; do not rediscover/replay it. */
        if(s->owns_child && !s->reap_incomplete) (void)observe(s);
        if(s->phase==F016_PENDING_KEEPER) return;
    }
    if(s->phase==F016_TAIL) {
        if(s->tail_rounds<2) {drain(s,true);s->tail_rounds++;return;}
        s->phase=F016_REAPING;
    }
    if(s->phase==F016_REAPING) {finish_reap(s);return;}
    if(observe(s)!=F016_RUNNING) return;
    if(s->phase==F016_TERMINATING) {
        drain(s,false);
        if(s->ops.monotonic_now(s->context)>=s->term_deadline) pending(s);
        return;
    }
    if(s->cause==F016_NO_CAUSE && !s->identity_attempted) {
        s->identity_attempted=true;
        bool bound=s->ops.capture_identity(s->context,s->deadline);active(s);
        /* An exit during capture supersedes binding; never signal an exited child. */
        if(observe(s)!=F016_RUNNING) return;
        s->identity_bound=bound;
        if(!bound) lock_cause(s,F016_IDENTITY_UNKNOWN);
    }
    if(s->cause==F016_NO_CAUSE) drain(s,true);
    if(s->cause!=F016_NO_CAUSE) {
        if(observe(s)!=F016_RUNNING) return;
        if(!s->identity_bound) {pending(s);return;}
        if(!s->term_attempted) {
            s->term_attempted=true;s->phase=F016_TERMINATING;
            uint64_t now=s->ops.monotonic_now(s->context);
            s->term_deadline=now>UINT64_MAX-F016_TERM_NS?UINT64_MAX:now+F016_TERM_NS;
            int result=s->ops.term_audittoken(s->context,s->term_deadline);active(s);
            if(result==F016_TERM_BINDING_LOST){lock_cause(s,F016_IDENTITY_UNKNOWN);pending(s);return;}
            if(s->ops.monotonic_now(s->context)>=s->term_deadline) pending(s);
        }
    }
}
void f016_step(f016_core *s) {
    if(s->step_inflight)return;
    s->step_inflight=true;
    step_internal(s);
    s->step_inflight=false;
}
const char *f016_report(const f016_core *s) {
    static char report[256];
    static const char *const causes[]={"none","cancelled","timeout","prepare_failed","spawn_failed",
        "identity_unknown","stderr_present","receipt_invalid","pipe_failed","ownership_unknown"};
    const char *result="observing";
    if(s->phase==F016_PENDING_KEEPER) result=s->owns_child?
        (s->reap_incomplete?"retained_child_reap_pending":"retained_child_pending"):"ownership_unknown";
    else if(s->phase==F016_DONE) {
        static const char *const allowed[]={"preflight_observed_unverified","known_refusal","prelaunch_refused",
            "interrupted","receipt_exit_invalid","cleanup_complete_unverified"};
        result="cleanup_complete_unverified";
        for(unsigned i=0;i<sizeof(allowed)/sizeof(allowed[0]);i++)if(!strcmp(s->result,allowed[i])){result=allowed[i];break;}
    }
    const char *cause=(unsigned)s->cause<sizeof(causes)/sizeof(causes[0])?causes[s->cause]:"ownership_unknown";
    (void)snprintf(report,sizeof(report),"{\"result\":\"%s\",\"cause\":\"%s\",\"principalVerified\":false,\"readyForDispatch\":false}\n",result,cause);
    return report;
}
void f016_emit_report(const f016_core *s,int (*write_once)(void *,const char *,size_t),void *context) {
    const char *report=f016_report(s);size_t length=strlen(report);
    if(length<=256 && write_once)(void)write_once(context,report,length);
    /* EPIPE/full/partial output is only a dropped report, never a state transition. */
}
