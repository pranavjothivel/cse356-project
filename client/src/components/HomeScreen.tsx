import { useState, useRef, useEffect, useContext } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { useIdle } from "@uidotdev/usehooks";

import AuthContext from "../auth";

import ProfileModal from "./ProfileModal";
import CommunitySidebar from "./CommunitySidebar";
import CommunityView from "./CommunityView";
import "./Communities.css";
import ConversationsPanel from "./ConversationsPanel";

export default function HomeScreen() {
    const { auth } = useContext(AuthContext);
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const idle = useIdle(60000);

    const [modal, setModal] = useState<string>("");
    const [oauthLinkedMsg, setOauthLinkedMsg] = useState<string>("");
    const [selectedCommunityId, setSelectedCommunityId] = useState<string | null>(null);
    const [view, setView] = useState<"home" | "dms">("home");
    const [unreadConvIds, setUnreadConvIds] = useState<Set<string>>(new Set());

    const ws = useRef<WebSocket|null>(null);

    useEffect(() => {
        console.log(auth.loggedIn);
        if (auth.loggedIn === false) {
            navigate("/login", { replace: true });
        }
        else if (auth.loggedIn) {
            fetch(import.meta.env.VITE_BACKEND_URL + "/auth/generate-ws-token", {credentials: "include"})
            .then(res => {
                if (res.ok) {
                    return res.json();
                }
                else {
                    throw new Error();
                }
            })
            .then(data => {
                const socket = new WebSocket(import.meta.env.VITE_WS_URL + `?token=${data.token}`);

                socket.addEventListener("message", (event) => {
                    let msg = event.data.toString();

                    // Don't give outside access until server has completed initialization
                    if (msg === "ready") {
                        ws.current = socket;

                        // Indicate initial presence
                        if (auth.user.away) sendMsg({type: "presence", value: "away"});
                        else sendMsg({type: "presence", value: "online"});
                    }
                    else if (msg === "away") {
                        auth.setAway(true, true);
                    }
                    else if (msg === "unaway") {
                        auth.setAway(false, true);
                    }
                    else {
                        // JSON-encoded server events (message.created, etc.)
                        try {
                            const parsed = JSON.parse(msg);
                            if (parsed && parsed.type) {
                                // Track unread DMs at the top level so the dot shows even when
                                // ConversationsPanel is not mounted (user is on another view)
                                if (parsed.type === 'message.created' && parsed.message?.authorId !== auth.user?.id) {
                                    setUnreadConvIds(prev => new Set(prev).add(parsed.conversationId));
                                }
                                window.dispatchEvent(new CustomEvent("ws-event", { detail: parsed }));
                            }
                        } catch { /* not JSON, ignore */ }
                    }
                });
            })
            .catch(err => {
                console.log("WS Setup Error:", err);
                ws.current = null;
            })

            if (ws.current !== null) return () => ws.current!.close();
        }
    }, [auth.loggedIn]);

    useEffect(() => {
        if (auth.loggedIn) {
            if (auth.user.away) {
                sendMsg({type: "presence", value: "away"});
            }
            else if (auth.user.away === false) {
                sendMsg({type: "presence", value: "unaway"});
            }
        }
    }, [auth.user?.away]);

    useEffect(() => {
        if (auth.loggedIn) {
            if (auth.user.away === false) {
                if (idle) {
                    sendMsg({type: "presence", value: "idle"});
                }
                else {
                    sendMsg({type: "presence", value: "online"});
                }
            }
        }
    }, [idle, auth.user?.away]);

    useEffect(() => {
        const linked = searchParams.get('linked');
        if (linked && auth.loggedIn) {
            auth.getLoggedIn().then(() => {
                setOauthLinkedMsg(linked + ' linked successfully');
                setModal('profile');
                navigate('/', { replace: true });
            });
        }
    }, [auth.loggedIn]);

    const sendMsg = (msg: any) => {
        if (ws.current) {
            ws.current!.send(JSON.stringify(msg));
        }
    }

    const logout = () => {
        auth.logout();
    }

    const changeModal = (newModal: string) => {
        setModal(newModal);
    }


    let modalContent: any = "";
    if (modal == "profile") {
        modalContent = <ProfileModal sendCallback={sendMsg} closeCallback={() => { changeModal(""); setOauthLinkedMsg(""); }} linkedMsg={oauthLinkedMsg}/>;
    }

    return (
        <div className="screen app-shell">
            <CommunitySidebar
                selectedId={selectedCommunityId}
                onSelect={(id) => { setSelectedCommunityId(id); if (id) setView("home"); }}
            />
            <div className="main-content">
                <div className="main-content-header" style={{justifyContent: "space-between"}}>
                    <div style={{display: "flex", gap: 12}}>
                        <div className="cursorPtr" onClick={() => setView("home")}>Home</div>
                        <div className="cursorPtr" onClick={() => setView("dms")} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            Direct Messages
                            {unreadConvIds.size > 0 && (
                                <span style={{ fontSize: 10, fontWeight: 700, color: "#5865f2", textTransform: "uppercase", letterSpacing: 0.3 }}>
                                    Unread
                                </span>
                            )}
                        </div>
                    </div>
                    <div style={{display: "flex", gap: 12}}>
                        <div className="cursorPtr" onClick={() => {changeModal("profile")}}>Profile</div>
                        <div className="cursorPtr" onClick={logout}>Logout</div>
                    </div>
                </div>
                {view === "dms" ? (
                    <ConversationsPanel unreadConvIds={unreadConvIds} setUnreadConvIds={setUnreadConvIds} />
                ) : selectedCommunityId ? (
                    <CommunityView communityId={selectedCommunityId} onLeft={() => setSelectedCommunityId(null)} />
                ) : (
                    <div style={{flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#666"}}>
                        Select or create a community to get started
                    </div>
                )}
            </div>
            {modalContent}
        </div>
    )
}