#include "supervisor_core.h"
#include <stdio.h>
#include <string.h>
#include <errno.h>

typedef struct {
    uint64_t now, spawn_delay, capture_delay, poll_delay;
    bool cancel, prepare_ok, spawn_ok, bind_ok, exited, lost, eof;
    bool prepare_cancel, term_reentry, reap_reentry, nested, perpetual_eintr;
    unsigned spawn, capture, term, reap, closes, polls, err_bytes;
    int term_code;
    f016_exit exit;
    const char *text; size_t length, position;
    f016_core *core;
} fixture;
static uint64_t clock_now(void *p){return ((fixture *)p)->now;}
static bool cancel(void *p){return ((fixture *)p)->cancel;}
static bool prepare(void *p){fixture *f=p;if(f->prepare_cancel)f->cancel=true;return f->prepare_ok;}
static bool spawn(void *p,uint64_t d){fixture *f=p;(void)d;f->spawn++;f->now+=f->spawn_delay;return f->spawn_ok;}
static f016_chunk poll_fake(void *p,uint64_t d){
    fixture *f=p;f016_chunk c={0};(void)d;f->polls++;f->now+=f->poll_delay;
    size_t n=f->length-f->position;c.out_len=n>F016_QUANTUM?F016_QUANTUM:n;
    if(c.out_len)memcpy(c.out,f->text+f->position,c.out_len);f->position+=c.out_len;
    if(f->err_bytes){c.err_len=1;c.err[0]='!';f->err_bytes--;}
    c.out_eof=f->eof && f->position==f->length;c.err_eof=f->eof && !f->err_bytes;return c;
}
static f016_observation observe(void *p,f016_exit *v){fixture *f=p;if(f->lost)return F016_OWNERSHIP_LOST;if(f->exited){*v=f->exit;return F016_EXITED;}return F016_RUNNING;}
static bool capture(void *p,uint64_t d){fixture *f=p;(void)d;f->capture++;f->now+=f->capture_delay;return f->bind_ok;}
static int term(void *p,uint64_t d){fixture *f=p;(void)d;f->term++;if(f->term_reentry && !f->nested){f->nested=true;f016_step(f->core);}return f->term_code;}
static f016_reap reap(void *p,f016_exit *v){
    fixture *f=p;f->reap++;
    if(f->reap_reentry && !f->nested){f->nested=true;f016_step(f->core);}
    if(f->perpetual_eintr)return F016_REAP_INTERRUPTED;
    *v=f->exit;return F016_REAPED;
}
static void close_owned(void *p){((fixture *)p)->closes++;}
static const f016_ops ops={clock_now,cancel,prepare,spawn,poll_fake,observe,capture,term,reap,close_owned};
static fixture good(unsigned i){fixture f={0};int code=0;f.text=f016_receipt_template(i,&code);f.length=strlen(f.text);f.prepare_ok=f.spawn_ok=f.bind_ok=f.eof=true;f.exit.normal=true;f.exit.code=code;return f;}
static void init(f016_core *s,fixture *f){f->core=s;f016_init(s,&ops,f);}
static void drive(f016_core *s,unsigned n){for(unsigned i=0;i<n && s->phase!=F016_DONE;i++)f016_step(s);}
#define CHECK(x) do {if(!(x)){printf("  failed: %s\n",#x);return false;}}while(0)
static bool no_success(f016_core *s){return strcmp(s->result,"preflight_observed_unverified") && strcmp(s->result,"known_refusal");}
static bool canonical(void){for(unsigned i=0;i<13;i++){fixture f=good(i);f.exited=true;f016_core s;init(&s,&f);drive(&s,8);CHECK(s.phase==F016_DONE);CHECK(!strcmp(s.result,i?"known_refusal":"preflight_observed_unverified"));CHECK(f.spawn==1 && f.capture==0 && f.term==0 && f.reap==1 && f.closes==1);drive(&s,10);CHECK(f.reap==1 && f.closes==1);}return true;}
static bool pre_cancel(void){fixture f=good(0);f.cancel=true;f016_core s;init(&s,&f);drive(&s,8);CHECK(f.spawn==0 && f.capture==0 && f.reap==0 && f.closes==1);return true;}
static bool bad_prepare(void){fixture f=good(0);f.prepare_ok=false;f016_core s;init(&s,&f);drive(&s,8);CHECK(f.spawn==0 && f.closes==1);return true;}
static bool prepare_cancel(void){fixture f=good(0);f.prepare_cancel=true;f016_core s;init(&s,&f);drive(&s,8);CHECK(f.spawn==0 && s.cause==F016_CANCELLED);return true;}
static bool late_spawn(void){fixture f=good(0);f.spawn_delay=F016_OBSERVE_NS;f016_core s;init(&s,&f);f016_step(&s);CHECK(s.phase==F016_PENDING_KEEPER && f.spawn==1 && f.term==0 && f.closes==0);f.exited=true;drive(&s,8);CHECK(no_success(&s) && f.reap==1 && f.closes==1);return true;}
static bool late_capture(void){fixture f=good(0);f.capture_delay=F016_OBSERVE_NS;f016_core s;init(&s,&f);f016_step(&s);CHECK(s.cause==F016_TIMEOUT && f.term==1);f.exited=true;drive(&s,8);CHECK(no_success(&s) && f.reap==1);return true;}
static bool late_tail(void){fixture f=good(0);f.exited=true;f.poll_delay=F016_OBSERVE_NS;f016_core s;init(&s,&f);drive(&s,8);CHECK(s.cause==F016_TIMEOUT && no_success(&s) && f.term==0 && f.reap==1);return true;}
static bool no_eof(void){fixture f=good(0);f.eof=false;f.exited=true;f016_core s;init(&s,&f);drive(&s,8);CHECK(f.polls==2 && f.reap==1 && !strcmp(s.result,"receipt_exit_invalid"));return true;}
static bool extra_byte(void){fixture f=good(0);char text[1024];memcpy(text,f.text,f.length);text[f.length]=' ';f.text=text;f.length++;f.exited=true;f016_core s;init(&s,&f);drive(&s,8);CHECK(no_success(&s) && f.reap==1 && f.term==0);return true;}
static bool stderr_reject(void){fixture f=good(0);f.err_bytes=1;f.exited=true;f016_core s;init(&s,&f);drive(&s,8);CHECK(s.cause==F016_STDERR_PRESENT && no_success(&s) && f.reap==1);return true;}
static bool signal_exit(void){fixture f=good(0);f.exited=true;f.exit.normal=false;f.exit.code=15;f016_core s;init(&s,&f);drive(&s,8);CHECK(!strcmp(s.result,"interrupted") && f.term==0 && f.reap==1);return true;}
static bool wrong_exit(void){fixture f=good(0);f.exited=true;f.exit.code=64;f016_core s;init(&s,&f);drive(&s,8);CHECK(!strcmp(s.result,"receipt_exit_invalid"));return true;}
static bool term_once(void){for(unsigned i=0;i<4;i++){fixture f=good(0);f.err_bytes=1;f.term_code=i==0?0:i==1?EINTR:i==2?ESRCH:EPERM;f.term_reentry=true;f016_core s;init(&s,&f);f016_step(&s);CHECK(f.term==1);f.now=s.term_deadline;drive(&s,10);CHECK(s.phase==F016_PENDING_KEEPER && f.term==1 && f.reap==0 && f.closes==0);f.exited=true;drive(&s,8);CHECK(f.term==1 && f.reap==1 && f.closes==1 && no_success(&s));}return true;}
static int broken_output(void *p,const char *text,size_t n){(void)p;(void)text;(void)n;errno=EPIPE;return -1;}
static bool ownership_output(void){fixture f=good(0);f.lost=true;f016_core s;init(&s,&f);drive(&s,10);CHECK(s.phase==F016_PENDING_KEEPER && !s.owns_child);f016_emit_report(&s,broken_output,NULL);drive(&s,10);CHECK(f.reap==0 && f.term==0 && f.closes==0 && !strcmp(s.result,"ownership_unknown"));return true;}
static bool reap_reentrant(void){fixture f=good(0);f.exited=true;f.reap_reentry=true;f016_core s;init(&s,&f);drive(&s,8);CHECK(f.reap==1 && s.reap_completed && f.closes==1);return true;}
static bool reap_interrupted_bounded(void){fixture f=good(0);f.exited=true;f.perpetual_eintr=true;f016_core s;init(&s,&f);drive(&s,100);CHECK(f.reap<=8 && s.phase==F016_PENDING_KEEPER && s.owns_child && f.term==0 && f.closes==0);return true;}
static int original_suite_main(void){struct test {const char *name;bool (*run)(void);} tests[]={
 {"canonical13",canonical},{"pre_cancel",pre_cancel},{"bad_prepare",bad_prepare},{"prepare_cancel",prepare_cancel},
 {"late_spawn",late_spawn},{"late_capture",late_capture},{"late_tail",late_tail},{"no_eof",no_eof},
 {"extra_byte",extra_byte},{"stderr",stderr_reject},{"signal_exit",signal_exit},{"wrong_exit",wrong_exit},
 {"term_once_reentrant_errno",term_once},{"ownership_output",ownership_output},{"reap_reentrant",reap_reentrant},{"reap_interrupted_bounded",reap_interrupted_bounded}};
 unsigned passed=0,failed=0;for(unsigned i=0;i<sizeof(tests)/sizeof(tests[0]);i++){bool ok=tests[i].run();printf("%s %s\n",ok?"PASS":"FAIL",tests[i].name);if(ok)passed++;else failed++;}printf("independent groups: %u pass %u fail\n",passed,failed);return failed?1:0;}


static void reenter(void *p){f016_step(((fixture *)p)->core);}
static uint64_t re_clock(void *p){reenter(p);return clock_now(p);}
static bool re_cancel(void *p){reenter(p);return cancel(p);}
static bool re_prepare(void *p){reenter(p);return prepare(p);}
static bool re_spawn(void *p,uint64_t d){reenter(p);return spawn(p,d);}
static f016_chunk re_poll(void *p,uint64_t d){reenter(p);return poll_fake(p,d);}
static f016_observation re_observe(void *p,f016_exit *v){reenter(p);return observe(p,v);}
static bool re_capture(void *p,uint64_t d){reenter(p);return capture(p,d);}
static int re_term(void *p,uint64_t d){reenter(p);return term(p,d);}
static f016_reap re_reap(void *p,f016_exit *v){reenter(p);return reap(p,v);}
static void re_close(void *p){reenter(p);close_owned(p);}
static const f016_ops re_ops={re_clock,re_cancel,re_prepare,re_spawn,re_poll,re_observe,re_capture,re_term,re_reap,re_close};
static bool every_ops_reentry(void){
 fixture f=good(0);f.exited=true;f016_core s;f.core=&s;f016_init(&s,&re_ops,&f);drive(&s,8);
 CHECK(s.phase==F016_DONE && !s.step_inflight && !s.reap_inflight && f.spawn==1 && f.reap==1 && f.closes==1);
 f=good(0);f.err_bytes=1;f.core=&s;f016_init(&s,&re_ops,&f);f016_step(&s);
 CHECK(f.spawn==1 && f.capture==1 && f.term==1 && !s.step_inflight);
 f.exited=true;drive(&s,8);CHECK(f.term==1 && f.reap==1 && f.closes==1 && !s.step_inflight);return true;
}
static unsigned interruptions;
static f016_reap finite_reap(void *p,f016_exit *v){fixture *f=p;if(interruptions){interruptions--;f->reap++;return F016_REAP_INTERRUPTED;}return reap(p,v);}
static bool seventh_interrupt_then_success(void){fixture f=good(0);f.exited=true;f016_core s;f.core=&s;f016_ops local=ops;local.reap_exact=finite_reap;interruptions=7;f016_init(&s,&local,&f);drive(&s,30);CHECK(s.phase==F016_DONE && f.reap==8 && s.reap_completed && !s.reap_incomplete && f.closes==1);return true;}
static f016_reap cancel_reap(void *p,f016_exit *v){((fixture *)p)->cancel=true;return reap(p,v);}
static bool cancel_during_reap(void){fixture f=good(0);f.exited=true;f016_core s;f.core=&s;f016_ops local=ops;local.reap_exact=cancel_reap;f016_init(&s,&local,&f);drive(&s,8);CHECK(s.phase==F016_DONE && s.cause==F016_CANCELLED && no_success(&s) && f.term==0 && f.reap==1 && f.closes==1);return true;}
int main(void){int original=original_suite_main();bool a=every_ops_reentry(),b=seventh_interrupt_then_success(),c=cancel_during_reap();printf("extra pure groups: %u pass %u fail\n",(unsigned)a+(unsigned)b+(unsigned)c,3u-((unsigned)a+(unsigned)b+(unsigned)c));return original || !a || !b || !c;}

