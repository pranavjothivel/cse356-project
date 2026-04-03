import { useState, useContext } from "react";

import AuthContext from "../auth";

export default function ProfileModal({ closeCallback } : any) {
    const { auth } = useContext(AuthContext);

    const [newDN, setNewDN] = useState("");
    const [newAM, setNewAM] = useState("");

    const [err, setErr] = useState("");

    const handleClose = () => {
        closeCallback();
    }

    const handleNewDNInput = (event: any) => {
        setNewDN(event.target.value);
    }

    const handleUpdateDN = async () => {
        let res = await fetch(import.meta.env.VITE_BACKEND_URL + "/auth/settings/update-profile", {
                    method: "POST",
                    credentials: "include",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({displayName: newDN})
                });
        if (res.ok) {
            setErr("");
            auth.user.displayName = newDN;
            setNewDN("");
        }
        else {
            setErr("Error");
        }
    }


    const handleNewAMInput = (event: any) => {
        setNewAM(event.target.value);
    }

    const handleUpdateAM = async () => {
        let res = await fetch(import.meta.env.VITE_BACKEND_URL + "/auth/settings/update-profile", {
                    method: "POST",
                    credentials: "include",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({away_msg: newAM})
                });
        if (res.ok) {
            setErr("");
            auth.user.away_msg = newAM;
            setNewAM("");
        }
        else {
            setErr("Error");
        }
    }

    const handleToggleAway = (event: any) => {
        auth.setAway();
    }

    return (
        <div className="modal-container">
            <div className="modal">
                <div>Id: {auth.user.id}</div>
                <div>Username: {auth.user.username}</div>
                <div style={{display: "flex"}}>
                    <div>Display Name: {auth.user.displayName}</div>
                    <input style={{marginLeft: "8px"}} type="text" placeholder="New Display Name" onKeyUp={handleNewDNInput}/>
                    <button style={{marginTop: "auto"}} onClick={handleUpdateDN}>Update Display Name</button>
                </div>
                <div>
                    <label>
                        <input type="checkbox" onChange={handleToggleAway} checked={auth.user.away}/> 
                        Set presence to away
                    </label>
                </div>
                <div style={{display: "flex"}}>
                    <div>Away Message: {auth.user.away_msg}</div>
                    <input style={{marginLeft: "8px"}} type="text" placeholder="New Away Message" onKeyUp={handleNewAMInput}/>
                    <button style={{marginTop: "auto"}} onClick={handleUpdateAM}>Update Away Message</button>
                </div>
                <div style={{color: "red"}}>
                    { err }
                </div>
                <button style={{marginTop: "16px"}} onClick={handleClose}>Close</button>
            </div>
        </div>
    )
}