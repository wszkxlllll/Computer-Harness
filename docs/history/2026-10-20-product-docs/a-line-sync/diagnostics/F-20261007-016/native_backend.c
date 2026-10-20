/* Darwin SOURCE ONLY: do not execute or link into fake tests. */
#include "supervisor_core.h"
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <CommonCrypto/CommonDigest.h>
#include <bsm/libbsm.h>
#include <mach/mach.h>
#include <mach/mach_traps.h>
#include <mach/task_info.h>
#include <libproc.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <spawn.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <unistd.h>
#include <dirent.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define CHILD "/private/tmp/F013-app-prep-20261007.Gw84nt/HarnessF005Diagnostic.app/Contents/MacOS/cua-driver-local"
#define APP "/private/tmp/F013-app-prep-20261007.Gw84nt/HarnessF005Diagnostic.app"
#define PLIST APP "/Contents/Info.plist"
#define RESOURCES APP "/Contents/_CodeSignature/CodeResources"
#define CHILD_SHA "46db151bd19763013eda935170be0fe1d408d9b7719d0aa4b0e0d0c1a72ed53e"
#define CDHASH "8f63caaee65f4cd54eb740b5c86631f5ce97002c"
#define PLIST_SHA "d989b8893271ee07cecc4a24142da5715cd02836acbfaf3dcc677fa3b5397e23"
#define RESOURCES_SHA "6686de10a28a2fe11b36cbb86dcbacc827cfc4ea116b4dabf1845e5aee629e9b"
#define EXPECTED_UID 501u
typedef struct {
    bool configured, prepared, launched, token_bound, term_attempted, reaped, out_eof, err_eof;
    pid_t pid;
    audit_token_t token;
    int input, out_read, out_write, err_read, err_write;
    struct stat file_stats[3];
    posix_spawn_file_actions_t actions;
    posix_spawnattr_t attrs;
    bool actions_live, attrs_live;
    unsigned rotate;
} native_context;
static native_context native;
static volatile sig_atomic_t cancelled_flag;
static void on_cancel(int sig) { (void)sig;cancelled_flag=1; }
static void close_fd(int *fd) {if(*fd>=0){(void)close(*fd);*fd=-1;}}
static bool same_file(const struct stat *a,const struct stat *b) {
    return a->st_dev==b->st_dev && a->st_ino==b->st_ino && a->st_mode==b->st_mode
        && a->st_size==b->st_size && a->st_mtimespec.tv_sec==b->st_mtimespec.tv_sec
        && a->st_mtimespec.tv_nsec==b->st_mtimespec.tv_nsec
        && a->st_ctimespec.tv_sec==b->st_ctimespec.tv_sec && a->st_ctimespec.tv_nsec==b->st_ctimespec.tv_nsec;
}
static bool plain_path(const char *path,bool regular) {
    char real[PATH_MAX],walk[PATH_MAX];struct stat st;
    if(!path || path[0]!='/' || strlen(path)>=sizeof(walk) || !realpath(path,real) || strcmp(real,path)) return false;
    strcpy(walk,path);
    for(char *p=walk+1;;p++) {
        if(*p=='/' || *p=='\0') {
            char save=*p;*p='\0';
            if(lstat(walk,&st)!=0 || S_ISLNK(st.st_mode) || (save? !S_ISDIR(st.st_mode): regular? !S_ISREG(st.st_mode): !S_ISDIR(st.st_mode))) return false;
            *p=save;if(!save)break;
        }
    }
    return true;
}
static void hex(const unsigned char *bytes,size_t n,char *out) {
    const char *digits="0123456789abcdef";
    for(size_t i=0;i<n;i++){out[2*i]=digits[bytes[i]>>4];out[2*i+1]=digits[bytes[i]&15];}out[2*n]='\0';
}
static bool digest_file(const char *path,const char *pin,off_t size,struct stat *saved) {
    if(!plain_path(path,true))return false;
    int fd=open(path,O_RDONLY|O_NOFOLLOW|O_CLOEXEC);if(fd<0)return false;
    bool ok=false;struct stat before,after,current;CC_SHA256_CTX hash;
    unsigned char buffer[8192],digest[CC_SHA256_DIGEST_LENGTH];char text[65];off_t count=0;
    if(fstat(fd,&before)!=0 || !S_ISREG(before.st_mode) || before.st_size!=size || !CC_SHA256_Init(&hash))goto end;
    for(;;) {
        ssize_t got=read(fd,buffer,sizeof(buffer));
        if(got<0){if(errno==EINTR)continue;goto end;}if(!got)break;
        if(count>size-got || !CC_SHA256_Update(&hash,buffer,(CC_LONG)got))goto end;count+=got;
    }
    if(count!=size || !CC_SHA256_Final(digest,&hash))goto end;hex(digest,sizeof(digest),text);
    if(strcmp(text,pin) || fstat(fd,&after)!=0 || lstat(path,&current)!=0 || !same_file(&before,&after) || !same_file(&after,&current))goto end;
    *saved=after;ok=true;
end:
    memset(buffer,0,sizeof(buffer));memset(digest,0,sizeof(digest));(void)close(fd);return ok;
}
static bool inventory(const char *path,unsigned *files) {
    if(!plain_path(path,false))return false;
    DIR *dir=opendir(path);if(!dir)return false;bool ok=true;struct dirent *entry;
    errno=0;
    while((entry=readdir(dir))) {
        if(!strcmp(entry->d_name,".") || !strcmp(entry->d_name,".."))continue;
        char item[PATH_MAX];struct stat st;
        int length=snprintf(item,sizeof(item),"%s/%s",path,entry->d_name);
        if(length<0 || (size_t)length>=sizeof(item) || lstat(item,&st)!=0){ok=false;break;}
        if(S_ISDIR(st.st_mode)) {
            if(strcmp(item,APP "/Contents") && strcmp(item,APP "/Contents/MacOS") && strcmp(item,APP "/Contents/_CodeSignature")){ok=false;break;}
            if(!inventory(item,files)){ok=false;break;}
        } else if(S_ISREG(st.st_mode)) {
            if(strcmp(item,CHILD) && strcmp(item,PLIST) && strcmp(item,RESOURCES)){ok=false;break;}
            if(++*files>3){ok=false;break;}
        } else {ok=false;break;}
        errno=0;
    }
    if(errno)ok=false;(void)closedir(dir);return ok;
}
static bool cf_string(CFDictionaryRef dict,CFStringRef key,CFStringRef expected) {
    CFTypeRef value=CFDictionaryGetValue(dict,key);
    return value && CFGetTypeID(value)==CFStringGetTypeID() && CFEqual(value,expected);
}
static bool signature(void) {
    bool ok=false;CFURLRef url=NULL;SecStaticCodeRef code=NULL;SecRequirementRef requirement=NULL;CFDictionaryRef info=NULL;
    url=CFURLCreateFromFileSystemRepresentation(NULL,(const UInt8 *)APP,strlen(APP),true);if(!url)goto end;
    if(SecStaticCodeCreateWithPath(url,kSecCSDefaultFlags,&code)!=errSecSuccess || !code)goto end;
    OSStatus requirement_status=SecRequirementCreateWithString(CFSTR("identifier \"org.computerharness.diagnostic.f005\""),kSecCSDefaultFlags,&requirement);
    if(requirement_status!=errSecSuccess){requirement=NULL;goto end;}
    if(!requirement)goto end;
    SecCSFlags flags=kSecCSStrictValidate|kSecCSNoNetworkAccess;
    if(SecStaticCodeCheckValidity(code,flags,requirement)!=errSecSuccess)goto end;
    OSStatus status=SecCodeCopySigningInformation(code,kSecCSSigningInformation,&info);
    if(status!=errSecSuccess){info=NULL;goto end;} /* Error out ownership is not assumed. */
    if(!info || CFGetTypeID(info)!=CFDictionaryGetTypeID())goto end;
    if(!cf_string(info,kSecCodeInfoIdentifier,CFSTR("org.computerharness.diagnostic.f005")))goto end;
    CFTypeRef unique=CFDictionaryGetValue(info,kSecCodeInfoUnique);
    if(!unique || CFGetTypeID(unique)!=CFDataGetTypeID() || CFDataGetLength((CFDataRef)unique)!=20)goto end;
    char cd[41];hex(CFDataGetBytePtr((CFDataRef)unique),20,cd);if(strcmp(cd,CDHASH))goto end;
    CFTypeRef signature_flags=CFDictionaryGetValue(info,kSecCodeInfoFlags);uint32_t bits=0;
    if(!signature_flags || CFGetTypeID(signature_flags)!=CFNumberGetTypeID()
        || !CFNumberGetValue((CFNumberRef)signature_flags,kCFNumberSInt32Type,&bits)
        || !(bits&kSecCodeSignatureAdhoc))goto end;
    CFTypeRef cms=CFDictionaryGetValue(info,kSecCodeInfoCMS);
    if(cms && (CFGetTypeID(cms)!=CFDataGetTypeID() || CFDataGetLength((CFDataRef)cms)!=0))goto end;
    CFTypeRef team=CFDictionaryGetValue(info,kSecCodeInfoTeamIdentifier);
    if(team)goto end;
    CFTypeRef entitlements=CFDictionaryGetValue(info,kSecCodeInfoEntitlementsDict);
    if(entitlements && (CFGetTypeID(entitlements)!=CFDictionaryGetTypeID() || CFDictionaryGetCount((CFDictionaryRef)entitlements)!=0))goto end;
    CFTypeRef blob=CFDictionaryGetValue(info,kSecCodeInfoEntitlements);
    if(blob && (CFGetTypeID(blob)!=CFDataGetTypeID() || CFDataGetLength((CFDataRef)blob)!=0))goto end;
    CFTypeRef rawplist=CFDictionaryGetValue(info,kSecCodeInfoPList);
    if(!rawplist || CFGetTypeID(rawplist)!=CFDictionaryGetTypeID())goto end;
    CFTypeRef mainexe=CFDictionaryGetValue(info,kSecCodeInfoMainExecutable);
    if(!mainexe || CFGetTypeID(mainexe)!=CFURLGetTypeID())goto end;
    CFStringRef mainpath=CFURLCopyFileSystemPath((CFURLRef)mainexe,kCFURLPOSIXPathStyle);
    if(!mainpath)goto end;
    bool mainmatch=CFEqual(mainpath,CFSTR(CHILD));CFRelease(mainpath);if(!mainmatch)goto end;
    CFDictionaryRef plist=(CFDictionaryRef)rawplist;
    if(CFDictionaryGetCount(plist)!=8 || !cf_string(plist,CFSTR("CFBundleIdentifier"),CFSTR("org.computerharness.diagnostic.f005"))
        || !cf_string(plist,CFSTR("CFBundleExecutable"),CFSTR("cua-driver-local"))
        || !cf_string(plist,CFSTR("CFBundleDisplayName"),CFSTR("Harness F005 Diagnostic"))
        || !cf_string(plist,CFSTR("CFBundlePackageType"),CFSTR("APPL")))goto end;
    if(SecStaticCodeCheckValidity(code,flags,requirement)!=errSecSuccess)goto end;
    ok=true;
end:
    if(info)CFRelease(info);if(requirement)CFRelease(requirement);if(code)CFRelease(code);if(url)CFRelease(url);return ok;
}
static int normalized_fd(int fd) {
    if(fd<0)return -1;
    if(fd<3){int replacement=fcntl(fd,F_DUPFD_CLOEXEC,3);(void)close(fd);return replacement;}
    if(fcntl(fd,F_SETFD,FD_CLOEXEC)<0){(void)close(fd);return -1;}return fd;
}
static bool make_pipe(int *read_fd,int *write_fd) {
    int pair[2];if(pipe(pair)<0)return false;
    *read_fd=normalized_fd(pair[0]);*write_fd=normalized_fd(pair[1]);
    if(*read_fd<0 || *write_fd<0)return false;
    int flags=fcntl(*read_fd,F_GETFL);return flags>=0 && fcntl(*read_fd,F_SETFL,flags|O_NONBLOCK)==0;
}
static uint64_t now(void *ctx) {
    (void)ctx;struct timespec value;
    if(clock_gettime(CLOCK_MONOTONIC,&value)!=0)return UINT64_MAX;
    return (uint64_t)value.tv_sec*UINT64_C(1000000000)+(uint64_t)value.tv_nsec;
}
static bool cancelled(void *ctx){(void)ctx;return cancelled_flag!=0;}
static void close_owned(void *ctx) {
    native_context *n=ctx;
    close_fd(&n->input);close_fd(&n->out_read);close_fd(&n->out_write);close_fd(&n->err_read);close_fd(&n->err_write);
    if(n->actions_live){posix_spawn_file_actions_destroy(&n->actions);n->actions_live=false;}
    if(n->attrs_live){posix_spawnattr_destroy(&n->attrs);n->attrs_live=false;}
}
static bool prepare(void *ctx) {
    native_context *n=ctx;unsigned files=0;
    if(!n->configured || getuid()!=EXPECTED_UID || geteuid()!=EXPECTED_UID || cancelled(ctx)
        || !inventory(APP,&files) || files!=3 || !digest_file(CHILD,CHILD_SHA,109967264,&n->file_stats[0])
        || !digest_file(PLIST,PLIST_SHA,702,&n->file_stats[1])
        || !digest_file(RESOURCES,RESOURCES_SHA,2200,&n->file_stats[2]) || !signature() || cancelled(ctx))return false;
    n->input=normalized_fd(open("/dev/null",O_RDONLY|O_CLOEXEC));
    if(n->input<0 || !make_pipe(&n->out_read,&n->out_write) || !make_pipe(&n->err_read,&n->err_write))return false;
    if(posix_spawn_file_actions_init(&n->actions)!=0)return false;n->actions_live=true;
    if(posix_spawnattr_init(&n->attrs)!=0)return false;n->attrs_live=true;
    int fds[5]={n->input,n->out_read,n->out_write,n->err_read,n->err_write};
    int sources[3];if(!f016_fd_plan(fds,sources))return false;
    for(unsigned i=0;i<3;i++)if(posix_spawn_file_actions_adddup2(&n->actions,sources[i],(int)i)!=0)return false;
    for(unsigned i=0;i<5;i++)if(fds[i]<3 || posix_spawn_file_actions_addclose(&n->actions,fds[i])!=0)return false;
    sigset_t defaults,mask;sigfillset(&defaults);sigdelset(&defaults,SIGKILL);sigdelset(&defaults,SIGSTOP);sigemptyset(&mask);
    short flags=POSIX_SPAWN_CLOEXEC_DEFAULT|POSIX_SPAWN_SETSIGDEF|POSIX_SPAWN_SETSIGMASK;
    if(posix_spawnattr_setsigdefault(&n->attrs,&defaults)!=0 || posix_spawnattr_setsigmask(&n->attrs,&mask)!=0
        || posix_spawnattr_setflags(&n->attrs,flags)!=0 || cancelled(ctx))return false;
    n->prepared=true;return true;
}
static bool spawn_fixed(void *ctx,uint64_t deadline) {
    native_context *n=ctx;
    if(!n->prepared || n->launched || cancelled(ctx))return false;
    const char *paths[3]={CHILD,PLIST,RESOURCES};struct stat current;
    for(unsigned i=0;i<3;i++)if(!plain_path(paths[i],true) || lstat(paths[i],&current)!=0 || !same_file(&n->file_stats[i],&current))return false;
    char *argv[3],*envp[1];if(!f016_fixed_invocation(CHILD,argv,envp))return false;
    if(cancelled(ctx) || now(ctx)>=deadline)return false;
    pid_t pid=0;int result=posix_spawn(&pid,CHILD,&n->actions,&n->attrs,argv,envp);
    if(result!=0)return false;
    n->pid=pid;n->launched=true;close_fd(&n->input);close_fd(&n->out_write);close_fd(&n->err_write);return true;
}
static f016_chunk poll_receipt(void *ctx,uint64_t deadline) {
    native_context *n=ctx;f016_chunk chunk={0};
    struct pollfd pipes[2]={{n->out_eof?-1:n->out_read,POLLIN|POLLHUP,0},{n->err_eof?-1:n->err_read,POLLIN|POLLHUP,0}};
    chunk.out_eof=n->out_eof;chunk.err_eof=n->err_eof;
    int ready=poll(pipes,2,50);
    if(ready<0){if(errno!=EINTR)chunk.failed=true;return chunk;}
    for(unsigned turn=0;turn<2;turn++) {
        unsigned i=(turn+n->rotate)%2;int fd=pipes[i].fd;
        if(fd<0) {if(i)chunk.err_eof=true;else chunk.out_eof=true;continue;}
        if(pipes[i].revents&(POLLERR|POLLNVAL)){chunk.failed=true;continue;}
        if(!(pipes[i].revents&(POLLIN|POLLHUP)))continue;
        ssize_t got=read(fd,i?chunk.err:chunk.out,F016_QUANTUM);
        if(got>0){if(i)chunk.err_len=(size_t)got;else chunk.out_len=(size_t)got;}
        else if(!got){if(i){chunk.err_eof=n->err_eof=true;}else{chunk.out_eof=n->out_eof=true;}}
        else if(errno!=EAGAIN && errno!=EWOULDBLOCK && errno!=EINTR)chunk.failed=true;
        /* Fair turn boundary: do not perform another read after cancellation. */
        if(cancelled(ctx) || now(ctx)>=deadline)break;
    }
    n->rotate^=1;return chunk;
}
static f016_observation observe(void *ctx,f016_exit *exit) {
    native_context *n=ctx;siginfo_t info;memset(&info,0,sizeof(info));
    if(!n->launched || n->reaped)return F016_OWNERSHIP_LOST;
    if(waitid(P_PID,(id_t)n->pid,&info,WEXITED|WNOHANG|WNOWAIT)<0) {
        if(errno==EINTR)return F016_RUNNING;
        return errno==ECHILD?F016_OWNERSHIP_LOST:F016_OBSERVE_ERROR;
    }
    if(info.si_pid==0)return F016_RUNNING;
    if(info.si_pid!=n->pid)return F016_OWNERSHIP_LOST;
    exit->normal=info.si_code==CLD_EXITED;exit->code=info.si_status;return F016_EXITED;
}
static bool capture(void *ctx,uint64_t deadline) {
    native_context *n=ctx;mach_port_name_t port=MACH_PORT_NULL;audit_token_t token;
    if(n->token_bound || n->reaped || !n->launched)return false;
    kern_return_t result=task_name_for_pid(mach_task_self(),n->pid,&port);
    if(result!=KERN_SUCCESS || port==MACH_PORT_NULL){if(port!=MACH_PORT_NULL)mach_port_deallocate(mach_task_self(),port);return false;}
    if(cancelled(ctx) || now(ctx)>=deadline){mach_port_deallocate(mach_task_self(),port);return false;}
    mach_msg_type_number_t count=TASK_AUDIT_TOKEN_COUNT;
    result=task_info(port,TASK_AUDIT_TOKEN,(task_info_t)&token,&count);
    (void)mach_port_deallocate(mach_task_self(),port);
    if(result!=KERN_SUCCESS || count!=TASK_AUDIT_TOKEN_COUNT || cancelled(ctx) || now(ctx)>=deadline)return false;
    char path[PROC_PIDPATHINFO_MAXSIZE];memset(path,0,sizeof(path));
    int length=proc_pidpath_audittoken(&token,path,sizeof(path));
    if(length<=0 || cancelled(ctx) || now(ctx)>=deadline || !memchr(path,'\0',sizeof(path))
        || !f016_identity_fields(audit_token_to_pid(token),n->pid,audit_token_to_euid(token),EXPECTED_UID,
            count,TASK_AUDIT_TOKEN_COUNT,audit_token_to_pidversion(token),path))return false;
    n->token=token;n->token_bound=true;return true;
}
static int term(void *ctx,uint64_t deadline) {
    native_context *n=ctx;
    if(n->term_attempted || n->reaped || !n->token_bound)return EPERM;
    n->term_attempted=true;
    char path[PROC_PIDPATHINFO_MAXSIZE];memset(path,0,sizeof(path));
    int length=proc_pidpath_audittoken(&n->token,path,sizeof(path));
    if(length<=0 || !memchr(path,'\0',sizeof(path)) || strcmp(path,CHILD) || now(ctx)>=deadline)return F016_TERM_BINDING_LOST;
    return proc_signal_with_audittoken(&n->token,SIGTERM); /* errno integer, no retries */
}
static f016_reap reap(void *ctx,f016_exit *exit) {
    native_context *n=ctx;int status=0;
    if(n->reaped || !n->launched)return F016_REAP_LOST;
    pid_t got=waitpid(n->pid,&status,WNOHANG);
    if(got<0)return errno==EINTR?F016_REAP_INTERRUPTED:errno==ECHILD?F016_REAP_LOST:F016_REAP_ERROR;
    if(got!=n->pid)return F016_REAP_ERROR;
    n->reaped=true;exit->normal=WIFEXITED(status);exit->code=exit->normal?WEXITSTATUS(status):WIFSIGNALED(status)?WTERMSIG(status):0;
    return F016_REAPED;
}
static const f016_ops ops={now,cancelled,prepare,spawn_fixed,poll_receipt,observe,capture,term,reap,close_owned};
const f016_ops *f016_native_ops(void){return &ops;}
void *f016_native_context(void){return &native;}
bool f016_native_configure(const char *child,const char *sha,const char *cdhash) {
    memset(&native,0,sizeof(native));native.input=native.out_read=native.out_write=native.err_read=native.err_write=-1;
    native.configured=f016_fixed_inputs(child,sha,cdhash);
    return native.configured;
}
void f016_native_install_handlers(void) {
    bool handlers_ok=true;
    struct sigaction action;memset(&action,0,sizeof(action));sigemptyset(&action.sa_mask);action.sa_handler=on_cancel;
    if(sigaction(SIGINT,&action,NULL)<0 || sigaction(SIGTERM,&action,NULL)<0)handlers_ok=false;
    action.sa_handler=SIG_IGN;if(sigaction(SIGPIPE,&action,NULL)<0)handlers_ok=false;
    action.sa_handler=SIG_DFL;action.sa_flags=0;if(sigaction(SIGCHLD,&action,NULL)<0)handlers_ok=false;
    if(!handlers_ok){cancelled_flag=1;return;}
    /* Inherited blocked cancellation signals must reach the flag handler.
       Unblock only these two; do not widen the parent's signal mask. */
    sigset_t cancellation;sigemptyset(&cancellation);sigaddset(&cancellation,SIGINT);sigaddset(&cancellation,SIGTERM);
    if(sigprocmask(SIG_UNBLOCK,&cancellation,NULL)<0)cancelled_flag=1;
}
static int report_write_once(void *ctx,const char *report,size_t length) {
    (void)ctx;
    int flags=fcntl(STDOUT_FILENO,F_GETFL);
    if(flags<0 || fcntl(STDOUT_FILENO,F_SETFL,flags|O_NONBLOCK)<0)return -1;
    return (int)write(STDOUT_FILENO,report,length); /* no retry; SIGPIPE ignored before spawn */
}
void f016_native_report(const f016_core *core) {
    f016_emit_report(core,report_write_once,NULL);
}
