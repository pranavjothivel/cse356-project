import { useState, useRef, useEffect, useContext } from "react";
import { useNavigate } from "react-router-dom";

import { useIdle } from "@uidotdev/usehooks";

import AuthContext from "../auth";

import ProfileModal from "./ProfileModal";

export default function HomeScreen() {
    const { auth } = useContext(AuthContext);
    const navigate = useNavigate();
    const idle = useIdle(5000);

    const [modal, setModal] = useState<string>("");

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
                        if (auth.user.away) sendMsg({type: "presence", value: "away"});
                    }
                    else if (msg === "away") {
                        auth.setAway(true, true);
                    }
                    else if (msg === "unaway") {
                        auth.setAway(false, true);
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
        if (auth.loggedIn) {
            if (auth.user.away) {
                sendMsg({type: "presence", value: "away"});
            }
            else if (auth.user.away === false) {
                sendMsg({type: "presence", value: "unaway"});
            }
        }
    }, [auth.user?.away]);

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
        modalContent = <ProfileModal sendCallback={sendMsg} closeCallback={() => {changeModal("")}}/>;
    }

    return (
        <div className="screen">
            <div style={{display: "flex"}}>
                <div className="cursorPtr" onClick={() => {changeModal("profile")}}>Profile</div>
                <div className="cursorPtr" style={{marginLeft: "16px"}} onClick={logout}>Logout</div>
            </div>
            {
                modalContent
            }
        </div>
    )
}