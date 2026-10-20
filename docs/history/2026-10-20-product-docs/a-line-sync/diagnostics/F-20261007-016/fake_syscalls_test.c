/* Links ONLY supervisor_core.c; no Darwin backend or native calls. */
#include "supervisor_core.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>

#define CHILD "/private/tmp/F013-app-prep-20261007.Gw84nt/HarnessF005Diagnostic.app/Contents/MacOS/cua-driver-local"
#define SHA "46db151bd19763013eda935170be0fe1d408d9b7719d0aa4b0e0d0c1a72ed53e"
#define CD "8f63caaee65f4cd54eb740b5c86631f5ce97002c"
typedef struct {
    uint64_t now, spawn_delay, capture_delay, poll_delay;
    bool cancel, cancel_prepare, cancel_capture, prepared, spawn_ok, identity_ok,
        exited, lost, observe_error, out_eof, err_eof, pipe_error, flood, reap_reentry, nested;
    f016_core *core;
    const unsigned char *bytes;size_t length, position;unsigned stderr_bytes;
    unsigned spawn_count, capture_count, term_count, reap_calls, reap_success,
        close_count, polls, observations, exit_after_poll, reap_eintr;
    int term_error;f016_exit exit;
} fake;
static uint64_t fake_now(void *p){return ((fake *)p)->now;}
static bool fake_cancel(void *p){return ((fake *)p)->cancel;}
static bool fake_prepare(void *p){fake *f=p;if(f->cancel_prepare)f->cancel=true;return f->prepared;}
static bool fake_spawn(void *p,uint64_t deadline){fake *f=p;(void)deadline;f->spawn_count++;f->now+=f->spawn_delay;return f->spawn_ok;}
static f016_chunk fake_poll(void *p,uint64_t deadline) {
    fake *f=p;f016_chunk c={0};(void)deadline;f->polls++;f->now+=f->poll_delay;
    if(f->pipe_error){c.failed=true;return c;}
    if(f->flood){c.out_len=c.err_len=F016_QUANTUM;memset(c.out,'x',sizeof(c.out));memset(c.err,'y',sizeof(c.err));}
    else {
        size_t remaining=f->length-f->position;c.out_len=remaining>F016_QUANTUM?F016_QUANTUM:remaining;
        if(c.out_len)memcpy(c.out,f->bytes+f->position,c.out_len);f->position+=c.out_len;
        if(f->stderr_bytes){c.err_len=f->stderr_bytes>F016_QUANTUM?F016_QUANTUM:f->stderr_bytes;memset(c.err,'z',c.err_len);f->stderr_bytes-=c.err_len;}
        c.out_eof=f->position==f->length && f->out_eof;c.err_eof=f->stderr_bytes==0 && f->err_eof;
    }
    if(f->exit_after_poll && f->polls>=f->exit_after_poll)f->exited=true;
    return c;
}
static f016_observation fake_observe(void *p,f016_exit *exit) {
    fake *f=p;f->observations++;
    if(f->lost)return F016_OWNERSHIP_LOST;if(f->observe_error)return F016_OBSERVE_ERROR;
    if(f->exited){*exit=f->exit;return F016_EXITED;}return F016_RUNNING;
}
static bool fake_capture(void *p,uint64_t deadline){fake *f=p;(void)deadline;f->capture_count++;f->now+=f->capture_delay;if(f->cancel_capture)f->cancel=true;return f->identity_ok;}
static int fake_term(void *p,uint64_t deadline){fake *f=p;(void)deadline;f->term_count++;return f->term_error;}
static f016_reap fake_reap(void *p,f016_exit *exit) {
    fake *f=p;f->reap_calls++;
    if(f->reap_reentry && !f->nested){f->nested=true;f016_step(f->core);}
    if(f->reap_eintr){f->reap_eintr--;return F016_REAP_INTERRUPTED;}
    if(f->lost)return F016_REAP_LOST;*exit=f->exit;f->reap_success++;return F016_REAPED;
}
static void fake_close(void *p){((fake *)p)->close_count++;}
static const f016_ops ops={fake_now,fake_cancel,fake_prepare,fake_spawn,fake_poll,fake_observe,fake_capture,fake_term,fake_reap,fake_close};
static fake good(unsigned index) {
    fake f={0};int code=0;const char *receipt=f016_receipt_template(index,&code);
    f.prepared=f.spawn_ok=f.identity_ok=f.out_eof=f.err_eof=true;f.exit.normal=true;f.exit.code=code;
    f.bytes=(const unsigned char *)receipt;f.length=strlen(receipt);f.exit_after_poll=2;f.poll_delay=UINT64_C(100000000);
    return f;
}
static void drive(f016_core *s,unsigned limit) {
    for(unsigned i=0;i<limit && s->phase!=F016_DONE && s->phase!=F016_PENDING_KEEPER;i++)f016_step(s);
}
static void no_success(const f016_core *s){assert(strcmp(s->result,"preflight_observed_unverified"));assert(strcmp(s->result,"known_refusal"));}
static int dropped_report(void *context,const char *bytes,size_t length) {
    int *error=context;assert(length<256 && !strstr(bytes,CHILD));errno=*error;return -1;
}
static void test_all_receipts(void) {
    for(unsigned i=0;i<13;i++) {
        fake f=good(i);f016_core s;f016_init(&s,&ops,&f);drive(&s,100);
        assert(s.phase==F016_DONE);assert(!strcmp(s.result,i==0?"preflight_observed_unverified":"known_refusal"));
        assert(f.spawn_count==1 && f.term_count==0 && f.reap_success==1 && f.close_count==1);
        f016_step(&s);assert(f.reap_success==1);assert(s.receipt_len==0);
        const char *report=f016_report(&s);assert(strlen(report)<256 && !strstr(report,CHILD) && strstr(report,"\"principalVerified\":false"));
    }
}
static void test_invalid_receipts(void) {
    unsigned char buffers[7][2100];const char *valid=f016_receipt_template(0,NULL);size_t size=strlen(valid);
    memset(buffers,0,sizeof(buffers));
    memcpy(buffers[0],valid,size);memcpy(buffers[0]+size,valid,size);
    memcpy(buffers[1],valid,size-1);
    memcpy(buffers[2],valid,size);buffers[2][size]=' ';
    memcpy(buffers[3],"{\"unknown\":true}\n",17);
    buffers[4][0]=0xff;buffers[4][1]='\n';
    memset(buffers[5],'x',1025);
    memcpy(buffers[6],valid,size);buffers[6][0]=' ';
    size_t lengths[]={size*2,size-1,size+1,17,2,1025,size};
    for(unsigned i=0;i<7;i++) {
        fake f=good(0);f.bytes=buffers[i];f.length=lengths[i];f.exited=true;
        f016_core s;f016_init(&s,&ops,&f);drive(&s,100);no_success(&s);
        assert(f.term_count==0 && f.reap_success==1 && f.close_count==1);
    }
    fake f=good(0);f.stderr_bytes=1;f016_core s;f016_init(&s,&ops,&f);drive(&s,100);
    assert(s.cause==F016_STDERR_PRESENT);no_success(&s);assert(f.term_count<=1);
}
static void test_exit_status(void) {
    fake f=good(0);f.exit.code=2;f016_core s;f016_init(&s,&ops,&f);drive(&s,100);assert(!strcmp(s.result,"receipt_exit_invalid"));
    f=good(0);f.exit.normal=false;f.exit.code=15;f016_init(&s,&ops,&f);drive(&s,100);assert(!strcmp(s.result,"interrupted"));
}
static void test_prelaunch_and_fixed_inputs(void) {
    for(unsigned i=0;i<3;i++) {
        fake f=good(0);if(i==0)f.prepared=false;if(i==1)f.cancel=true;if(i==2)f.cancel_prepare=true;
        f016_core s;f016_init(&s,&ops,&f);drive(&s,20);assert(f.spawn_count==0 && f.close_count==1);
    }
    assert(f016_fixed_inputs(CHILD,SHA,CD));assert(!f016_fixed_inputs("/other",SHA,CD));
    assert(!f016_fixed_inputs(CHILD,"incorrect",CD));assert(!f016_fixed_inputs(CHILD,SHA,"incorrect"));assert(!f016_fixed_inputs(NULL,SHA,CD));
    char *argv[3],*envp[1];assert(f016_fixed_invocation(CHILD,argv,envp));
    assert(!strcmp(argv[0],CHILD) && !strcmp(argv[1],"diagnostic-preflight-only") && !argv[2] && !envp[0]);
    fake f=good(0);f.spawn_ok=false;f016_core s;f016_init(&s,&ops,&f);drive(&s,10);assert(f.spawn_count==1 && !s.spawned && f.reap_calls==0);
}
static void test_fd_planning(void) {
    int fds[5]={3,4,5,6,7},sources[3];assert(f016_fd_plan(fds,sources));assert(sources[0]==3 && sources[1]==5 && sources[2]==7);
    for(int fd=0;fd<3;fd++){fds[0]=fd;assert(!f016_fd_plan(fds,sources));}fds[0]=3;fds[1]=3;assert(!f016_fd_plan(fds,sources));
    /* Closed parent 0/1/2 can yield raw low descriptors: the production planner
       rejects them until backend F_DUPFD_CLOEXEC normalized distinct >=3. */
}
static void test_identity_fields(void) {
    assert(f016_identity_fields(7,7,501,501,8,8,3,CHILD));
    assert(!f016_identity_fields(8,7,501,501,8,8,3,CHILD));assert(!f016_identity_fields(7,7,502,501,8,8,3,CHILD));
    assert(!f016_identity_fields(7,7,501,501,7,8,3,CHILD));assert(!f016_identity_fields(7,7,501,501,8,8,0,CHILD));
    assert(!f016_identity_fields(7,7,501,501,8,8,3,"/wrong"));
    fake f=good(0);f.identity_ok=false;f016_core s;f016_init(&s,&ops,&f);drive(&s,20);
    assert(s.phase==F016_PENDING_KEEPER && s.owns_child && f.capture_count==1 && f.term_count==0 && f.close_count==0);
    f.exited=true;drive(&s,0);for(unsigned i=0;i<10;i++)f016_step(&s);assert(s.phase==F016_DONE && f.reap_success==1 && f.close_count==1);no_success(&s);
}
static void test_fast_exit(void) {
    fake f=good(0);f.exited=true;f016_core s;f016_init(&s,&ops,&f);drive(&s,20);
    assert(f.capture_count==0 && f.term_count==0 && f.reap_success==1);assert(!strcmp(s.result,"preflight_observed_unverified"));
}
static void test_deadline_and_cancel(void) {
    for(unsigned i=0;i<4;i++) {
        fake f=good(0);f016_core s;f016_init(&s,&ops,&f);
        if(i==0)f.spawn_delay=F016_OBSERVE_NS;if(i==1)f.capture_delay=F016_OBSERVE_NS;
        if(i==2)f.cancel_capture=true;
        f016_step(&s);
        if(i==3){f.now=s.deadline;f016_step(&s);}
        assert(s.cause== (i==2?F016_CANCELLED:F016_TIMEOUT));
        f.exited=true;for(unsigned j=0;j<20;j++)f016_step(&s);no_success(&s);assert(f.reap_success==1 && f.term_count<=1);
    }
    fake f=good(0);f016_core s;f016_init(&s,&ops,&f);f016_step(&s);f.now=s.deadline;f.cancel=true;f016_step(&s);
    assert(s.cause==F016_CANCELLED);f.now+=F016_OBSERVE_NS;f016_step(&s);assert(s.cause==F016_CANCELLED);
}
static void test_term_once_pending_and_reap(void) {
    for(unsigned i=0;i<4;i++) {
        fake f=good(0);f.exit_after_poll=0;f.stderr_bytes=1;f.term_error=i==0?0:i==1?EINTR:i==2?ESRCH:EPERM;
        f016_core s;f016_init(&s,&ops,&f);f016_step(&s);assert(f.term_count==1 && s.term_attempted);
        f.now=s.term_deadline;f016_step(&s);assert(s.phase==F016_PENDING_KEEPER && f.close_count==0);
        for(unsigned j=0;j<20;j++)f016_step(&s);assert(f.term_count==1 && f.reap_calls==0 && f.close_count==0);
        /* Dropped EPIPE/full report cannot change core state or release keeper. */
        for(unsigned j=0;j<3;j++){int error=j==0?EPIPE:j==1?EAGAIN:EINTR;f016_emit_report(&s,dropped_report,&error);assert(s.phase==F016_PENDING_KEEPER && f.close_count==0);}
        f.exited=true;f.reap_eintr=2;for(unsigned j=0;j<20;j++)f016_step(&s);
        assert(s.phase==F016_DONE && f.reap_calls==3 && f.reap_success==1 && f.term_count==1 && f.close_count==1);no_success(&s);
    }
}
static void test_ownership_unknown(void) {
    for(unsigned i=0;i<2;i++) {
        fake f=good(0);f.lost=i==0;f.observe_error=i==1;f016_core s;f016_init(&s,&ops,&f);drive(&s,30);
        assert(s.phase==F016_PENDING_KEEPER && !s.owns_child);assert(!strcmp(s.result,"ownership_unknown"));
        unsigned observations=f.observations;for(unsigned j=0;j<10;j++)f016_step(&s);
        assert(f.observations==observations && f.term_count==0 && f.reap_calls==0 && f.close_count==0);
    }
}
static void test_descendant_and_flood(void) {
    fake f=good(0);f.out_eof=f.err_eof=false;f.exited=true;f016_core s;f016_init(&s,&ops,&f);drive(&s,20);
    assert(f.polls==2 && f.reap_success==1 && !strcmp(s.result,"receipt_exit_invalid"));
    f=good(0);f.flood=true;f.exit_after_poll=0;f016_init(&s,&ops,&f);f016_step(&s);
    assert(f.term_count==1 && s.stderr_count==F016_QUANTUM && s.stdout_count==F016_QUANTUM);
    f.now=s.term_deadline;f016_step(&s);for(unsigned i=0;i<30;i++)f016_step(&s);
    assert(s.stdout_count<=1025 && s.stderr_count<=1025 && f.close_count==0 && f.term_count==1);
}
static void test_reap_reentry(void) {
    fake f=good(0);f.exited=true;f.reap_reentry=true;f016_core s;f.core=&s;
    f016_init(&s,&ops,&f);drive(&s,20);
    assert(s.phase==F016_DONE && s.reap_completed && !s.reap_inflight);
    assert(f.reap_calls==1 && f.reap_success==1 && f.close_count==1 && f.term_count==0);
}
static void test_reap_eintr_budget_keeper(void) {
    fake f=good(0);f.exited=true;f.reap_eintr=1000;f016_core s;
    f016_init(&s,&ops,&f);drive(&s,100);
    assert(s.phase==F016_PENDING_KEEPER && s.reap_incomplete && s.owns_child && s.exit_observed);
    assert(!s.reap_completed && f.reap_calls==8 && f.term_count==0 && f.close_count==0);
    unsigned observed=f.observations;
    for(unsigned i=0;i<100;i++)f016_step(&s);
    assert(f.reap_calls==8 && f.observations==observed && f.close_count==0 && f.term_count==0);
    assert(strstr(f016_report(&s),"retained_child_reap_pending"));
}
int main(void) {
    test_all_receipts();test_invalid_receipts();test_exit_status();test_prelaunch_and_fixed_inputs();test_fd_planning();
    test_identity_fields();test_fast_exit();test_deadline_and_cancel();test_term_once_pending_and_reap();test_ownership_unknown();test_descendant_and_flood();
    test_reap_reentry();test_reap_eintr_budget_keeper();
    puts("F016 fake-only: 13 groups passed (includes all 13 canonical receipts)");return 0;
}
