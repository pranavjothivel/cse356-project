import { useContext } from "react";

import AuthContext from "../auth";

export default function ProfileModal({ closeCallback } : any) {
    const { auth } = useContext(AuthContext);

    const handleClose = () => {
        closeCallback();
    }

    return (
        <div className="modal-container">
            <div className="modal">
                <div>Id: {auth.user.id}</div>
                <div>Username: {auth.user.username}</div>
                <div>Display Name: {auth.user.displayName}</div>
                <button style={{marginTop: "auto"}} onClick={handleClose}>Close</button>
            </div>
        </div>
    )
}