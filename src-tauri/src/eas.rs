use base64::Engine;
use serde::Serialize;
use std::net::ToSocketAddrs;
use std::sync::Mutex;
use std::time::Duration;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Person {
    pub name: String,
    pub email: String,
    pub dept: String,
}

const SWITCH: u8 = 0x00;
const END: u8 = 0x01;
const STR_I: u8 = 0x03;
const OPAQUE: u8 = 0xC3;

const PAGE_PROVISION: u8 = 14;
const PAGE_SEARCH: u8 = 15;
const PAGE_GAL: u8 = 16;

#[derive(Debug, Default)]
pub struct Node {
    pub page: u8,
    pub tag: u8,
    pub text: String,
    pub children: Vec<Node>,
}

impl Node {
    fn child(&self, page: u8, tag: u8) -> Option<&Node> {
        self.children.iter().find(|c| c.page == page && c.tag == tag)
    }
    fn all(&self, page: u8, tag: u8) -> impl Iterator<Item = &Node> {
        self.children.iter().filter(move |c| c.page == page && c.tag == tag)
    }
    fn text_of(&self, page: u8, tag: u8) -> String {
        self.child(page, tag).map(|c| c.text.trim().to_string()).unwrap_or_default()
    }
}

pub struct Writer {
    buf: Vec<u8>,
    page: u8,
}

impl Writer {
    pub fn new() -> Self {
        Writer { buf: vec![0x03, 0x01, 0x6A, 0x00], page: 0 }
    }
    fn page(&mut self, p: u8) {
        if self.page != p {
            self.buf.extend([SWITCH, p]);
            self.page = p;
        }
    }
    pub fn open(&mut self, p: u8, tag: u8) -> &mut Self {
        self.page(p);
        self.buf.push(tag | 0x40);
        self
    }
    pub fn end(&mut self) -> &mut Self {
        self.buf.push(END);
        self
    }
    pub fn text(&mut self, p: u8, tag: u8, s: &str) -> &mut Self {
        self.open(p, tag);
        self.buf.push(STR_I);
        self.buf.extend(s.as_bytes());
        self.buf.push(0);
        self.end()
    }
    pub fn finish(self) -> Vec<u8> {
        self.buf
    }
}

fn mb_u32(b: &[u8], i: &mut usize) -> Result<u32, String> {
    let mut v: u32 = 0;
    for _ in 0..5 {
        let x = *b.get(*i).ok_or("wbxml truncated")?;
        *i += 1;
        v = (v << 7) | (x & 0x7F) as u32;
        if x & 0x80 == 0 {
            return Ok(v);
        }
    }
    Err("wbxml bad int".into())
}

pub fn parse(b: &[u8]) -> Result<Node, String> {
    let mut i = 1;
    mb_u32(b, &mut i)?;
    mb_u32(b, &mut i)?;
    let st = mb_u32(b, &mut i)? as usize;
    i += st;
    let mut page = 0u8;
    let mut stack: Vec<Node> = vec![Node::default()];
    while i < b.len() {
        let t = b[i];
        i += 1;
        match t {
            SWITCH => {
                page = *b.get(i).ok_or("wbxml truncated")?;
                i += 1;
            }
            END => {
                if stack.len() > 1 {
                    let n = stack.pop().unwrap();
                    stack.last_mut().unwrap().children.push(n);
                }
            }
            STR_I => {
                let end = b[i..].iter().position(|&x| x == 0).ok_or("wbxml bad string")?;
                stack.last_mut().unwrap().text.push_str(&String::from_utf8_lossy(&b[i..i + end]));
                i += end + 1;
            }
            OPAQUE => {
                let n = mb_u32(b, &mut i)? as usize;
                let end = (i + n).min(b.len());
                stack.last_mut().unwrap().text.push_str(&String::from_utf8_lossy(&b[i..end]));
                i = end;
            }
            _ => {
                if t & 0x80 != 0 {
                    return Err("wbxml attributes unsupported".into());
                }
                let n = Node { page, tag: t & 0x3F, ..Default::default() };
                if t & 0x40 != 0 {
                    stack.push(n);
                } else {
                    stack.last_mut().unwrap().children.push(n);
                }
            }
        }
    }
    while stack.len() > 1 {
        let n = stack.pop().unwrap();
        stack.last_mut().unwrap().children.push(n);
    }
    stack.pop().unwrap().children.into_iter().next().ok_or_else(|| "empty wbxml".into())
}

pub fn search_body(q: &str, max: u32) -> Vec<u8> {
    let mut w = Writer::new();
    w.open(PAGE_SEARCH, 0x05).open(PAGE_SEARCH, 0x07);
    w.text(PAGE_SEARCH, 0x08, "GAL").text(PAGE_SEARCH, 0x09, q);
    w.open(PAGE_SEARCH, 0x0A).text(PAGE_SEARCH, 0x0B, &format!("0-{}", max.saturating_sub(1))).end();
    w.end().end();
    w.finish()
}

fn provision_body(key: Option<&str>) -> Vec<u8> {
    let mut w = Writer::new();
    w.open(PAGE_PROVISION, 0x05).open(PAGE_PROVISION, 0x06).open(PAGE_PROVISION, 0x07);
    w.text(PAGE_PROVISION, 0x08, "MS-EAS-Provisioning-WBXML");
    if let Some(k) = key {
        w.text(PAGE_PROVISION, 0x09, k).text(PAGE_PROVISION, 0x0B, "1");
    }
    w.end().end().end();
    w.finish()
}

fn policy_key(root: &Node) -> Option<String> {
    let p = root.child(PAGE_PROVISION, 0x06)?.child(PAGE_PROVISION, 0x07)?;
    let k = p.text_of(PAGE_PROVISION, 0x09);
    (!k.is_empty()).then_some(k)
}

pub enum Found {
    People(Vec<Person>),
    NeedProvision,
}

pub fn read_search(root: &Node) -> Result<Found, String> {
    let st = root.text_of(PAGE_SEARCH, 0x0C);
    if matches!(st.as_str(), "142" | "143" | "144") {
        return Ok(Found::NeedProvision);
    }
    if !st.is_empty() && st != "1" {
        return Err(format!("公司通讯录返回状态 {}", st));
    }
    let Some(store) = root.child(PAGE_SEARCH, 0x0D).and_then(|r| r.child(PAGE_SEARCH, 0x07)) else {
        return Ok(Found::People(vec![]));
    };
    let sst = store.text_of(PAGE_SEARCH, 0x0C);
    if !sst.is_empty() && sst != "1" {
        return Err(format!("公司通讯录返回状态 {}", sst));
    }
    let mut out = Vec::new();
    for r in store.all(PAGE_SEARCH, 0x0E) {
        let Some(p) = r.child(PAGE_SEARCH, 0x0F) else { continue };
        let email = p.text_of(PAGE_GAL, 0x0F);
        if email.is_empty() {
            continue;
        }
        let mut name = p.text_of(PAGE_GAL, 0x05);
        if name.is_empty() {
            name = format!("{}{}", p.text_of(PAGE_GAL, 0x0C), p.text_of(PAGE_GAL, 0x0B));
        }
        let mut dept = p.text_of(PAGE_GAL, 0x07);
        if dept.is_empty() {
            dept = p.text_of(PAGE_GAL, 0x09);
        }
        out.push(Person { name, email, dept });
    }
    Ok(Found::People(out))
}

const PROVIDERS: &[(&str, &str)] = &[("imap.exmail.qq.com", "ex.exmail.qq.com"), ("imap.qq.com", "ex.qq.com")];

fn ips(host: &str) -> Vec<std::net::IpAddr> {
    (host, 993).to_socket_addrs().map(|a| a.map(|s| s.ip()).collect()).unwrap_or_default()
}

pub fn detect_host(imap_host: &str) -> Option<String> {
    let h = imap_host.trim().to_lowercase();
    if h.is_empty() {
        return None;
    }
    for (imap, ex) in PROVIDERS {
        if h == *imap {
            return Some(ex.to_string());
        }
    }
    let mine = ips(&h);
    if mine.is_empty() {
        return None;
    }
    for (imap, ex) in PROVIDERS {
        if ips(imap).iter().any(|ip| mine.contains(ip)) {
            return Some(ex.to_string());
        }
    }
    None
}

pub struct Client {
    pub host: String,
    pub login: String,
    pub pass: String,
    pub device: String,
}

struct Session {
    key: String,
    version: String,
    policy: Option<String>,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

pub fn reset() {
    if let Ok(mut g) = SESSION.lock() {
        *g = None;
    }
}

fn agent() -> ureq::Agent {
    let b = ureq::AgentBuilder::new().timeout(Duration::from_secs(12));
    match native_tls::TlsConnector::new() {
        Ok(t) => b.tls_connector(std::sync::Arc::new(t)).build(),
        Err(_) => b.build(),
    }
}

fn http_err(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(401, _) => "公司通讯录登录被拒绝，请检查邮箱密码".into(),
        ureq::Error::Status(403, _) => "公司通讯录没有开放（Exchange 同步未开启）".into(),
        ureq::Error::Status(c, _) => format!("公司通讯录返回 HTTP {}", c),
        ureq::Error::Transport(t) => format!("连不上公司通讯录（{}）", t),
    }
}

impl Client {
    fn url(&self) -> String {
        format!("https://{}/Microsoft-Server-ActiveSync", self.host)
    }
    fn auth(&self) -> String {
        let raw = format!("{}:{}", self.login, self.pass);
        format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(raw))
    }
    fn session_key(&self) -> String {
        format!("{}|{}", self.host, self.login)
    }

    fn version(&self) -> String {
        let r = agent().request("OPTIONS", &self.url()).set("Authorization", &self.auth()).call();
        let list = match r {
            Ok(resp) => resp.header("MS-ASProtocolVersions").unwrap_or("").to_string(),
            Err(_) => String::new(),
        };
        let have: Vec<&str> = list.split(',').map(|s| s.trim()).collect();
        for v in ["14.0", "12.1", "14.1", "16.0", "16.1", "12.0"] {
            if have.contains(&v) {
                return v.to_string();
            }
        }
        "14.0".into()
    }

    fn post(&self, cmd: &str, version: &str, policy: Option<&str>, body: &[u8]) -> Result<Vec<u8>, ureq::Error> {
        let url = format!(
            "{}?Cmd={}&User={}&DeviceId={}&DeviceType=Liuguang",
            self.url(),
            cmd,
            urlencode(&self.login),
            self.device
        );
        let mut req = agent()
            .post(&url)
            .set("Authorization", &self.auth())
            .set("MS-ASProtocolVersion", version)
            .set("Content-Type", "application/vnd.ms-sync.wbxml")
            .set("User-Agent", "Liuguang/1.0");
        if let Some(p) = policy {
            req = req.set("X-MS-PolicyKey", p);
        }
        let resp = req.send_bytes(body)?;
        let mut out = Vec::new();
        std::io::Read::read_to_end(&mut resp.into_reader(), &mut out).map_err(ureq::Error::from)?;
        Ok(out)
    }

    fn provision(&self, version: &str) -> Result<String, String> {
        let first = self.post("Provision", version, None, &provision_body(None)).map_err(http_err)?;
        let temp = policy_key(&parse(&first)?).ok_or("公司通讯录拒绝了设备登记")?;
        let second = self.post("Provision", version, Some(&temp), &provision_body(Some(&temp))).map_err(http_err)?;
        Ok(policy_key(&parse(&second)?).unwrap_or(temp))
    }

    pub fn search(&self, q: &str, max: u32) -> Result<Vec<Person>, String> {
        let key = self.session_key();
        let cached = SESSION.lock().ok().and_then(|mut g| g.take()).filter(|s| s.key == key);
        let mut s = match cached {
            Some(s) => s,
            None => Session { key: key.clone(), version: self.version(), policy: None },
        };
        let body = search_body(q, max);
        let mut tries = 0;
        let out = loop {
            tries += 1;
            let r = self.post("Search", &s.version, s.policy.as_deref(), &body);
            let need = match r {
                Ok(bytes) if bytes.is_empty() => break Ok(vec![]),
                Ok(bytes) => match read_search(&parse(&bytes)?)? {
                    Found::People(p) => break Ok(p),
                    Found::NeedProvision => true,
                },
                Err(ureq::Error::Status(449, _)) => true,
                Err(e) => break Err(http_err(e)),
            };
            if need && tries < 3 {
                s.policy = Some(self.provision(&s.version)?);
            } else {
                break Err("公司通讯录要求设备登记，未能完成".into());
            }
        };
        if out.is_ok() {
            if let Ok(mut g) = SESSION.lock() {
                *g = Some(s);
            }
        }
        out
    }
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{:02X}", b),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_request_bytes() {
        let b = search_body("谭", 50);
        assert_eq!(&b[..6], &[0x03, 0x01, 0x6A, 0x00, 0x00, 0x0F]);
        let n = parse(&b).unwrap();
        assert_eq!((n.page, n.tag), (15, 0x05));
        let store = n.child(15, 0x07).unwrap();
        assert_eq!(store.text_of(15, 0x08), "GAL");
        assert_eq!(store.text_of(15, 0x09), "谭");
        assert_eq!(store.child(15, 0x0A).unwrap().text_of(15, 0x0B), "0-49");
    }

    #[test]
    fn reads_results() {
        let mut w = Writer::new();
        w.open(15, 0x05).text(15, 0x0C, "1").open(15, 0x0D).open(15, 0x07).text(15, 0x0C, "1");
        for (n, e, o) in [("张三", "san.zhang@example.com", "研发部"), ("李四", "si.li@example.com", "")] {
            w.open(15, 0x0E).open(15, 0x0F).text(16, 0x05, n).text(16, 0x07, o).text(16, 0x0F, e).end().end();
        }
        w.text(15, 0x0B, "0-1").text(15, 0x10, "2").end().end().end();
        let Found::People(p) = read_search(&parse(&w.finish()).unwrap()).unwrap() else { panic!() };
        assert_eq!(p.len(), 2);
        assert_eq!(p[0], Person { name: "张三".into(), email: "san.zhang@example.com".into(), dept: "研发部".into() });
        assert_eq!(p[1].dept, "");
    }

    #[test]
    fn provision_status() {
        let mut w = Writer::new();
        w.open(15, 0x05).text(15, 0x0C, "142").end();
        assert!(matches!(read_search(&parse(&w.finish()).unwrap()).unwrap(), Found::NeedProvision));
        let mut w = Writer::new();
        w.open(14, 0x05).text(14, 0x0B, "1").open(14, 0x06).open(14, 0x07).text(14, 0x08, "MS-EAS-Provisioning-WBXML").text(14, 0x0B, "1").text(14, 0x09, "123456").end().end().end();
        assert_eq!(policy_key(&parse(&w.finish()).unwrap()).as_deref(), Some("123456"));
    }

    #[test]
    fn opaque_and_empty_tags() {
        let b = [0x03, 0x01, 0x6A, 0x00, 0x00, 0x0F, 0x45, 0x0C, 0x4D, 0xC3, 0x02, b'o', b'k', 0x01, 0x01];
        let n = parse(&b).unwrap();
        assert_eq!(n.children.len(), 2);
        assert_eq!(n.text_of(15, 0x0D), "ok");
    }

    #[test]
    fn known_provider_host() {
        assert_eq!(detect_host("imap.exmail.qq.com").as_deref(), Some("ex.exmail.qq.com"));
        assert_eq!(detect_host(""), None);
    }
}
