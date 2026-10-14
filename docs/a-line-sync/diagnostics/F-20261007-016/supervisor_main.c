#include "supervisor_core.h"
#include <string.h>

int main(int argc,char **argv) {
    const char *child=NULL,*sha=NULL,*cdhash=NULL;
    if(argc!=7) return 64;
    for(int i=1;i<argc;i+=2) {
        if(strcmp(argv[i],"--child")==0 && !child) child=argv[i+1];
        else if(strcmp(argv[i],"--sha256")==0 && !sha) sha=argv[i+1];
        else if(strcmp(argv[i],"--cdhash")==0 && !cdhash) cdhash=argv[i+1];
        else return 64;
    }
    if(!child || !sha || !cdhash || !f016_native_configure(child,sha,cdhash)) return 64;
    f016_native_install_handlers();
    f016_core core;f016_init(&core,f016_native_ops(),f016_native_context());
    const char *reported="";
    for(;;) {
        f016_step(&core);
        if(core.phase==F016_PENDING_KEEPER && strcmp(reported,core.result)) {
            f016_native_report(&core);reported=core.result;
        }
        if(core.phase==F016_DONE) {
            f016_native_report(&core);
            return strcmp(core.result,"preflight_observed_unverified")==0?0:2;
        }
        /* Pending is deliberately non-terminating. EPIPE/full reports never exit
           this keeper; no launcher, retry, PID signal, or release path exists. */
    }
}
