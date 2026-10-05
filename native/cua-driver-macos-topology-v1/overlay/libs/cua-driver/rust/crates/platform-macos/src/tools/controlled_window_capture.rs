//! Native-only, uncached independent-window capture. No title access,
//! shell fallback, identity rebinding, retries, or input authority.
use std::collections::HashSet;
use serde_json::{json,Value};
use screencapturekit::{prelude::{SCContentFilter,SCShareableContent,SCStreamConfiguration},
    shareable_content::SCWindow,screenshot_manager::{CGImageExt,SCScreenshotManager}};

const MAX_WINDOWS:usize=4096;
const MAX_DIM:u32=8192;
const MAX_BYTES:usize=64*1024*1024;
#[derive(Clone,Copy,Debug,PartialEq)]
pub(super) struct Bound {pub pid:i32,pub id:u32,pub frame:[f64;4]}
#[derive(Clone,Copy,Debug,PartialEq)]
struct Viewport {rect:[f64;4],scale:f64,width:u32,height:u32,bytes:usize}
pub(super) struct Captured {pub png:Vec<u8>,pub viewport:Value}
fn viewport(rect:[f64;4],scale:f64)->Result<Viewport,&'static str>{
    if !rect.iter().all(|v|v.is_finite()) || rect[2]<=0.0 || rect[3]<=0.0
        || !scale.is_finite() || scale<=0.0 || scale>16.0{return Err("session_viewport_invalid");}
    let dim=|n:f64|{let n=(n*scale).round();if n.is_finite() && n>=1.0 && n<=f64::from(MAX_DIM){Ok(n as u32)}else{Err("session_viewport_invalid")}};
    let width=dim(rect[2])?;let height=dim(rect[3])?;
    let bytes=(width as usize).checked_mul(height as usize).and_then(|n|n.checked_mul(4))
        .filter(|n|*n<=MAX_BYTES).ok_or("session_pixel_limit")?;
    Ok(Viewport{rect,scale,width,height,bytes})
}
fn unique_index(total:usize,id:u32,mut get:impl FnMut(usize)->u32)->Result<usize,&'static str>{
    if total==0 || total>MAX_WINDOWS{return Err("session_sc_inventory_invalid");}
    let mut seen=HashSet::new();let mut found=None;
    for index in 0..total {let actual=get(index);if actual==0 || !seen.insert(actual){return Err("session_sc_inventory_invalid");}
        if actual==id{found=Some(index);}}
    found.ok_or("session_sc_target_missing")
}
fn match_bound(expected:Bound,pid:i32,id:u32,layer:i32,frame:[f64;4])->Result<(),&'static str>{
    if pid!=expected.pid || id!=expected.id || layer!=0 || frame!=expected.frame{return Err("session_sc_identity_changed");}Ok(())
}
fn plan(expected:Bound,alive:&mut impl FnMut()->Result<(),&'static str>)
    ->Result<(SCWindow,SCContentFilter,SCStreamConfiguration,Viewport),&'static str>{
    alive()?;
    let content=SCShareableContent::get().map_err(|_|"session_sc_inventory_unavailable")?;
    alive()?;let windows=content.windows();
    let index=unique_index(windows.len(),expected.id,|i|windows[i].window_id())?;
    let window=windows[index].clone();let frame=window.frame();
    let owner=window.owning_application().ok_or("session_sc_identity_changed")?;
    match_bound(expected,owner.process_id(),window.window_id(),window.window_layer(),
        [frame.origin.x,frame.origin.y,frame.size.width,frame.size.height])?;
    alive()?;
    let filter=SCContentFilter::create().with_window(&window).build();
    let rect=filter.content_rect();let viewport=viewport([rect.origin.x,rect.origin.y,rect.size.width,rect.size.height],f64::from(filter.point_pixel_scale()))?;
    let config=SCStreamConfiguration::new().with_width(viewport.width).with_height(viewport.height);
    Ok((window,filter,config,viewport))
}
fn actual_image(viewport:Viewport,width:usize,height:usize,bytes:usize)->Result<(),&'static str>{
    if width!=viewport.width as usize || height!=viewport.height as usize || bytes!=viewport.bytes{return Err("session_image_invalid");}Ok(())
}
/// `revalidate` checks the same retained AX/app objects, never a replacement.
/// The actor holds its in-flight slot until this synchronous call actually ends.
pub(super) fn capture(expected:Bound,mut alive:impl FnMut()->Result<(),&'static str>,
    mut revalidate:impl FnMut()->Result<(),&'static str>)->Result<Captured,&'static str>{
    alive()?;
    if !crate::permissions::status::screen_recording_granted(){return Err("session_screen_recording_required");}
    revalidate()?;alive()?;
    let (_window,filter,config,before)=plan(expected,&mut alive)?;
    alive()?;
    let image=SCScreenshotManager::capture_image(&filter,&config).map_err(|_|"session_capture_failed")?;
    // A receiver timeout does not stop SCK. Never extract/publish late pixels.
    alive()?;
    if image.width()!=before.width as usize || image.height()!=before.height as usize{return Err("session_image_invalid");}
    // Locked SCK6.0.1 normalizes the source CGImage to packed 8-bit RGBA.
    let rgba=image.rgba_data().map_err(|_|"session_image_invalid")?;
    actual_image(before,image.width(),image.height(),rgba.len())?;alive()?;
    revalidate()?;alive()?;
    let (_after_window,_after_filter,_after_config,after)=plan(expected,&mut alive)?;
    if before!=after{return Err("session_viewport_changed");}
    revalidate()?;alive()?;
    let png=cua_driver_core::image_utils::encode_rgba_to_png(&rgba,before.width,before.height).map_err(|_|"session_encode_failed")?;
    if png.is_empty() || png.len()>MAX_BYTES{return Err("session_pixel_limit");}alive()?;
    Ok(Captured{png,viewport:json!({"content_rect":{"x":before.rect[0],"y":before.rect[1],"width":before.rect[2],"height":before.rect[3]},
        "point_pixel_scale":before.scale,"pixel_width":before.width,"pixel_height":before.height,"rgba_bytes":before.bytes})})
}

#[cfg(test)]mod tests {
    use super::*;
    #[test]fn independent_capture_viewport_and_actual_dimensions_are_not_frame_fallback(){
        let p=viewport([-2.0,3.0,10.0,12.0],2.0).unwrap();assert_eq!((p.width,p.height,p.bytes),(20,24,1920));
        for (r,s) in [([0.0,0.0,0.0,2.0],1.0),([f64::NAN,0.0,2.0,2.0],1.0),([0.0,0.0,2.0,2.0],0.0),([0.0,0.0,8192.0,8192.0],1.0)]{assert!(viewport(r,s).is_err());}
        assert!(actual_image(p,20,24,1920).is_ok());assert!(actual_image(p,24,20,1920).is_err());assert!(actual_image(p,20,24,1919).is_err());
    }
    #[test]fn independent_capture_unique_inventory_rejects_unknown_duplicates_before_selection(){
        assert_eq!(unique_index(3,7,|i|[1,7,9][i]),Ok(1));
        assert!(unique_index(3,7,|i|[7,7,9][i]).is_err());assert!(unique_index(3,7,|i|[0,7,9][i]).is_err());
        assert!(unique_index(4097,7,|_|panic!("overlimit getter")).is_err());
        let b=Bound{pid:1,id:7,frame:[0.0,0.0,2.0,2.0]};assert!(match_bound(b,1,7,0,b.frame).is_ok());
        assert!(match_bound(b,2,7,0,b.frame).is_err());assert!(match_bound(b,1,7,1,b.frame).is_err());
    }
}
